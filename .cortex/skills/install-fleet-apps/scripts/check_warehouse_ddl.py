#!/usr/bin/env python3
"""Enforce a single, consistent warehouse spec across install-fleet-apps.

WHY THIS GATE EXISTS
--------------------
Seven files in this skill used to run `CREATE WAREHOUSE IF NOT EXISTS
ROUTING_ANALYTICS`, and they disagreed three ways:

  * provision_engine.sh        - no WAREHOUSE_SIZE, no AUTO_SUSPEND at all
  * three deploy/bundle .sh    - WAREHOUSE_SIZE = XSMALL, AUTO_SUSPEND = 600
  * three .sql layers          - WAREHOUSE_SIZE = 'XSMALL', AUTO_SUSPEND = 60

Because `CREATE ... IF NOT EXISTS` turns every statement after the first into a
silent no-op, the spec an account ended up with was decided by whichever install
step happened to run first. Nothing failed and nothing warned. The spec was
simply not reproducible from one install to the next, which is exactly the kind
of defect no other gate here can see: every existing check verifies that objects
were CREATED, not that they were created the way the source claims.

WHAT IT CHECKS
--------------
1. `scripts/warehouses.sql` exists and declares both owned warehouses.
2. Every other `CREATE WAREHOUSE` for an owned name, anywhere in this skill,
   carries a spec whose functional parameters match the owner exactly.
3. No file introduces a `CREATE WAREHOUSE` for a name this skill does not own
   (a typo'd or invented warehouse would otherwise be created and granted
   nothing, which is how the SA app's `|| 'COMPUTE_WH'` fallback pointed at a
   warehouse the installer never creates).

COMMENT is compared too, because a tracking tag is a hard requirement here and a
divergent one is a real defect, not cosmetics.

Exit 0 clean, 1 on any drift. Read-only: parses files, touches no account.
"""
from __future__ import annotations

import re
import sys
from pathlib import Path

SKILL_DIR = Path(__file__).resolve().parent.parent
OWNER = SKILL_DIR / "scripts" / "warehouses.sql"

# Warehouses this skill owns and therefore may create.
OWNED = {"ROUTING_ANALYTICS", "FLEET_APPS_WH"}

# Parameters that change behaviour. INITIALLY_SUSPENDED is deliberately NOT
# compared: it only affects the moment of creation, so the owner's ALTER cannot
# converge it and a site omitting it is harmless.
COMPARED = (
    "WAREHOUSE_SIZE",
    "AUTO_SUSPEND",
    "AUTO_RESUME",
    "MIN_CLUSTER_COUNT",
    "MAX_CLUSTER_COUNT",
    "STATEMENT_TIMEOUT_IN_SECONDS",
    "COMMENT",
)

# `CREATE WAREHOUSE [IF NOT EXISTS] <name> <body-up-to-semicolon>`. Matches the
# multi-line .sql form and the single-line, backslash-escaped form the shell
# scripts embed in a `snow sql -q "..."` payload.
CREATE_RE = re.compile(
    r"CREATE\s+WAREHOUSE\s+(?:IF\s+NOT\s+EXISTS\s+)?([A-Za-z_][A-Za-z0-9_$]*)(.*?);",
    re.IGNORECASE | re.DOTALL,
)


def normalise(value: str) -> str:
    """Strip quoting and shell escaping so the .sh and .sql forms compare equal.

    The shell sites write COMMENT = '{\\"origin\\":...}' inside a double-quoted
    -q payload, while the .sql sites write COMMENT = '{"origin":...}'. Those are
    the same spec and must not be reported as drift.
    """
    v = value.strip().replace('\\"', '"')
    if len(v) >= 2 and v[0] == v[-1] and v[0] in "'\"":
        v = v[1:-1]
    return v.strip()


def parse_params(body: str) -> dict[str, str]:
    """Pull the compared parameters out of one CREATE WAREHOUSE body."""
    found: dict[str, str] = {}
    for key in COMPARED:
        # Value runs to the next parameter keyword or end of body. Quoted values
        # (COMMENT, WAREHOUSE_SIZE) are captured whole.
        m = re.search(
            rf"\b{key}\s*=\s*('(?:[^']|\\')*'|\"(?:[^\"]|\\\")*\"|[^\s;]+)",
            body,
            re.IGNORECASE,
        )
        if m:
            found[key] = normalise(m.group(1))
    return found


def strip_comments(text: str, suffix: str) -> str:
    """Blank out comment text so prose about DDL is not parsed AS DDL.

    This is load-bearing, not tidiness: these files explain the very drift this
    gate prevents, so they quote `CREATE WAREHOUSE IF NOT EXISTS ROUTING_ANALYTICS`
    in prose. The first version of this gate parsed those sentences and reported
    warehouses named "HERE" and "IF" -- it failed on the comments written to
    document it. Newlines are preserved so reported line numbers stay accurate.
    """
    if suffix == ".sql":
        text = re.sub(r"/\*.*?\*/", lambda m: "\n" * m.group(0).count("\n"), text, flags=re.DOTALL)
        text = re.sub(r"--[^\n]*", "", text)
    else:
        # Shell: only whole-line comments. An inline `#` strip would corrupt the
        # double-quoted `snow sql -q "..."` payloads these scripts embed.
        text = re.sub(r"(?m)^[ \t]*#[^\n]*", "", text)
    return text


def collect(path: Path) -> list[tuple[str, dict[str, str], int]]:
    """Return (warehouse_name, params, line_number) for each CREATE in a file."""
    try:
        raw = path.read_text(encoding="utf-8", errors="replace")
    except OSError:
        return []
    text = strip_comments(raw, path.suffix)
    out = []
    for m in CREATE_RE.finditer(text):
        name = m.group(1).upper()
        # `IF NOT EXISTS` is optional in the pattern, so a truncated or prose
        # fragment can capture a keyword as the name. Never treat one as a
        # warehouse.
        if name in {"IF", "NOT", "EXISTS"}:
            continue
        line = text[: m.start()].count("\n") + 1
        out.append((name, parse_params(m.group(2)), line))
    return out


def main() -> int:
    if not OWNER.exists():
        print(f"FAIL: canonical warehouse file missing: {OWNER}")
        return 1

    canonical: dict[str, dict[str, str]] = {}
    for name, params, _line in collect(OWNER):
        canonical.setdefault(name, params)

    missing = OWNED - set(canonical)
    if missing:
        print(f"FAIL: {OWNER.name} does not declare: {', '.join(sorted(missing))}")
        return 1

    errors: list[str] = []
    checked = 0

    for path in sorted(SKILL_DIR.rglob("*")):
        if path.suffix not in {".sql", ".sh"} or not path.is_file():
            continue
        if "node_modules" in path.parts or ".next" in path.parts:
            continue
        rel = path.relative_to(SKILL_DIR)

        for name, params, line in collect(path):
            if name not in OWNED:
                errors.append(
                    f"{rel}:{line}: creates unowned warehouse {name}. Add it to "
                    f"scripts/warehouses.sql (and grant it) or drop the statement -- "
                    f"an ungranted warehouse fails every query at runtime."
                )
                continue
            if path == OWNER:
                continue
            checked += 1
            want = canonical[name]
            for key, want_val in want.items():
                got = params.get(key)
                if got is None:
                    errors.append(
                        f"{rel}:{line}: {name} omits {key} (owner declares "
                        f"{key} = {want_val}). Match scripts/warehouses.sql exactly."
                    )
                elif got.upper().strip("'\"") != want_val.upper().strip("'\""):
                    errors.append(
                        f"{rel}:{line}: {name} has {key} = {got}, owner declares "
                        f"{want_val}. `IF NOT EXISTS` would hide this disagreement."
                    )

    if errors:
        print("FAIL: warehouse DDL drift detected\n")
        for e in errors:
            print(f"  {e}")
        print(
            f"\n{len(errors)} problem(s). scripts/warehouses.sql is the single owner "
            f"of every warehouse spec in this skill."
        )
        return 1

    print(
        f"PASS: {checked} duplicate CREATE WAREHOUSE site(s) match "
        f"scripts/warehouses.sql ({', '.join(sorted(OWNED))})"
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())

#!/usr/bin/env python3
"""Guard: the two Snowflake tracking mechanisms AGENTS.md makes mandatory.

    1. Every SQL session sets `query_tag` with origin `sf_sit-is-fleet`.
    2. Every created object carries a JSON `COMMENT` tracking tag.

Both failures are invisible at runtime - an untagged object works perfectly and
an untagged session returns the right rows - so nothing except a static check
notices. What breaks is downstream: credit attribution by origin, and the
cleanup skill (`routing-solution-cleanup`), which discovers objects to drop
purely by their COMMENT tag. An untagged object is invisible to it and survives
a teardown, which on SPCS services and compute pools means it keeps billing.

Three classes of defect are checked:

  A. A `.sql` file with no `ALTER SESSION SET query_tag`.
  B. A `CREATE <tracked type>` with no `COMMENT` (and no following
     `ALTER ... SET COMMENT`, which is the required form for CTAS).
  C. A tag whose JSON does not parse, or which is missing the schema AGENTS.md
     specifies: `version.major` / `version.minor` (NOT a bare `"1.0"` string),
     `attributes.is_quickstart`, `attributes.source`, and an `oss-` prefixed
     name. This class matters because these tags parse fine and look correct -
     but a consumer filtering on `version.major` or `is_quickstart` silently
     matches none of them.
  D. A `snow sql -q` invocation in a `.sh` whose payload runs DDL/DML without a
     `query_tag` in the SAME invocation. Each `snow sql` call is a new session,
     so a tag set by an earlier call does not carry over - which is exactly how
     several installer steps ran untagged.

Object COMMENTs are checked inside procedure bodies too, not just at top level.
A `$$`-aware splitter alone would treat a `CREATE TABLE` nested in a procedure
as part of the enclosing `CREATE PROCEDURE` statement and inherit its COMMENT -
which is how an untagged self-healing `CREATE TABLE IF NOT EXISTS` inside
`APPLY_ORS_LIMITS` went unnoticed.

Usage:
    python3 .cortex/skills/install-fleet-apps/scripts/check_tracking_tags.py

Exit 0 = clean, 1 = at least one untagged session, object, or malformed tag.
"""
from __future__ import annotations

import json
import pathlib
import re
import sys

REPO_ROOT = pathlib.Path(__file__).resolve().parents[4]

ORIGIN = "sf_sit-is-fleet"

# Directories that are vendored, generated, or archived. `_installed/` holds
# materialized install.sql (gitignored output of the synapse codegen), so the tag
# there is the generator's responsibility, not the file's.
SKIP_DIR_PARTS = {
    "node_modules", ".next", "dist", "build", "__pycache__", ".git",
    "archive", "_installed", "logs", "tmp", ".venv", "venv",
}

# ── Object types that must carry a COMMENT tracking tag ─────────────────────
# Ordered longest-first so "DYNAMIC TABLE" wins over "TABLE" and
# "SEMANTIC VIEW" over "VIEW".
TRACKED_TYPES = [
    "SEMANTIC VIEW", "DYNAMIC TABLE", "HYBRID TABLE", "ICEBERG TABLE",
    "MATERIALIZED VIEW", "IMAGE REPOSITORY", "COMPUTE POOL", "FILE FORMAT",
    "EXTERNAL ACCESS INTEGRATION", "NOTIFICATION INTEGRATION",
    "SECURITY INTEGRATION", "CATALOG INTEGRATION", "STORAGE INTEGRATION",
    "API INTEGRATION", "MCP SERVER", "NETWORK RULE", "EVENT TABLE",
    "STREAMLIT", "PROCEDURE", "FUNCTION", "DATABASE", "WAREHOUSE", "SCHEMA",
    "SEQUENCE", "SERVICE", "STREAM", "STAGE", "TABLE", "VIEW", "TASK", "ROLE",
    "AGENT", "ALERT", "PIPE",
]

CREATE_RE = re.compile(
    r"\bCREATE\s+(?:OR\s+REPLACE\s+)?"
    r"(?:(?:GLOBAL\s+|LOCAL\s+)?(?:TEMP|TEMPORARY|TRANSIENT|VOLATILE)\s+)*"
    r"(?:SECURE\s+|RECURSIVE\s+)*"
    r"(" + "|".join(t.replace(" ", r"\s+") for t in TRACKED_TYPES) + r")\b"
    r"(?:\s+IF\s+NOT\s+EXISTS)?\s+([A-Za-z0-9_.$\"{}:\-]+)?",
    re.IGNORECASE,
)

QUERY_TAG_RE = re.compile(r"query_tag\s*=", re.IGNORECASE)

# A JSON tracking tag, in either the plain or the doubled-single-quote (dynamic
# SQL) form. Non-greedy up to the matching close of the nested attributes object.
TAG_RE = re.compile(r'\{\s*""?origin""?\s*:\s*""?[^"\']*?""?.*?\}\s*\}', re.DOTALL)


# ── Documented platform exceptions ─────────────────────────────────────────
# Each entry is (matcher, reason). These are cases where Snowflake itself makes
# the tag impossible, NOT cases we chose to skip. Adding one is a deliberate
# edit, which is the point: a silent pass would let a real miss hide here.
def _is_service_function(stmt: str) -> bool:
    # CREATE FUNCTION ... SERVICE=<svc> is an SPCS service function: Snowflake
    # rejects both an inline COMMENT and ALTER FUNCTION ... SET COMMENT.
    return bool(re.search(r"\bSERVICE\s*=", stmt, re.IGNORECASE))


def _is_from_listing(stmt: str) -> bool:
    # CREATE DATABASE ... FROM LISTING mounts a read-only share; the COMMENT
    # clause is not accepted and the mounted DB cannot be ALTERed either.
    return bool(re.search(r"\bFROM\s+LISTING\b", stmt, re.IGNORECASE))


def _is_from_share(stmt: str) -> bool:
    return bool(re.search(r"\bFROM\s+SHARE\b", stmt, re.IGNORECASE))


def _is_temp(stmt: str) -> bool:
    # Session-scoped: dropped automatically at session end, so it is never left
    # behind for the cleanup skill to find and cannot accrue cost.
    return bool(re.search(
        r"\bCREATE\s+(?:OR\s+REPLACE\s+)?"
        r"(?:GLOBAL\s+|LOCAL\s+)?(?:TEMP|TEMPORARY|VOLATILE)\b",
        stmt, re.IGNORECASE))


TYPE_EXCEPTIONS = {
    # CREATE MCP SERVER ... FROM SPECIFICATION has no COMMENT clause at all.
    # Tracked via its JSON-tagged parent schema instead (see synapse tracking.ts).
    "MCP SERVER": "no COMMENT clause exists on CREATE MCP SERVER",
    # A semantic view has exactly ONE object-level COMMENT and it carries the
    # Cortex Analyst model description, which the agent reads. Replacing that
    # with a JSON tag would degrade Analyst; the two uses collide on one slot.
    "SEMANTIC VIEW": "single COMMENT slot holds the Cortex Analyst description",
}

STMT_EXCEPTIONS = [
    (_is_service_function, "SPCS service function accepts no COMMENT"),
    (_is_from_listing, "FROM LISTING share mount accepts no COMMENT"),
    (_is_from_share, "FROM SHARE mount accepts no COMMENT"),
    (_is_temp, "session-scoped temporary object"),
]


def iter_files(suffix: str):
    """Walk the repo yielding *suffix files, PRUNING skipped directories.

    `Path.rglob` would descend into every node_modules tree before the filter
    rejected the paths, which cost ~17s - too slow for a pre-commit hook. Pruning
    dirnames in os.walk keeps the whole check well under a second.
    """
    import os
    found = []
    for dirpath, dirnames, filenames in os.walk(REPO_ROOT):
        dirnames[:] = [d for d in dirnames if d not in SKIP_DIR_PARTS]
        for fn in filenames:
            if fn.endswith(suffix):
                found.append(pathlib.Path(dirpath) / fn)
    return sorted(found)


def strip_comments(sql: str) -> str:
    """Blank out -- line comments and /* */ blocks, preserving length/offsets.

    Comments are stripped INSIDE `$$...$$` bodies too. Procedure bodies are where
    most of the prose lives, and prose reads like DDL ("Idempotent (CREATE SERVICE
    IF NOT EXISTS) so safe to call on rebuilds") - which a CREATE scan would
    otherwise report as an untagged object. Only single-quoted strings are
    protected, since a `--` inside one is data, not a comment.
    """
    out = list(sql)
    i, n = 0, len(sql)
    in_sq = False
    while i < n:
        two = sql[i:i + 2]
        if sql[i] == "'":
            in_sq = not in_sq
            i += 1
            continue
        if not in_sq and two == "--":
            while i < n and sql[i] != "\n":
                out[i] = " "
                i += 1
            continue
        if not in_sq and two == "/*":
            while i < n and sql[i:i + 2] != "*/":
                out[i] = " "
                i += 1
            for j in range(i, min(i + 2, n)):
                out[j] = " "
            i += 2
            continue
        i += 1
    return "".join(out)


def split_statements(sql: str):
    """Split on ';' at top level, honouring '...' strings and $$...$$ bodies.

    Yields (statement_text, offset_of_statement_start).
    """
    stmts = []
    buf_start = 0
    i, n = 0, len(sql)
    in_sq = in_dollar = False
    while i < n:
        if not in_sq and sql[i:i + 2] == "$$":
            in_dollar = not in_dollar
            i += 2
            continue
        if not in_dollar and sql[i] == "'":
            in_sq = not in_sq
            i += 1
            continue
        if sql[i] == ";" and not in_sq and not in_dollar:
            stmts.append((sql[buf_start:i + 1], buf_start))
            i += 1
            buf_start = i
            continue
        i += 1
    if sql[buf_start:].strip():
        stmts.append((sql[buf_start:], buf_start))
    return stmts


def inner_statements(stmt: str, base: int):
    """Split the $$...$$ bodies of `stmt` into their own statements.

    Needed because a CREATE nested inside a procedure body would otherwise
    inherit the enclosing CREATE PROCEDURE's COMMENT.
    """
    out = []
    for m in re.finditer(r"\$\$(.*?)\$\$", stmt, re.DOTALL):
        body, off = m.group(1), base + m.start(1)
        for s, so in split_statements(body):
            out.append((s, off + so))
    return out


def line_of(text: str, offset: int) -> int:
    return text.count("\n", 0, offset) + 1


def has_comment_clause(stmt: str) -> bool:
    """True if the statement carries a COMMENT that looks like a tracking tag."""
    # Must be a statement-level COMMENT = '<json with origin>'. Column-level
    # COMMENTs (common in semantic views / table DDL) are not object tags, so
    # require the origin marker rather than the bare keyword.
    for m in re.finditer(r"COMMENT\s*=\s*(''|')", stmt, re.IGNORECASE):
        tail = stmt[m.end():m.end() + 400]
        if ORIGIN in tail:
            return True
    return False


def check_sql_file(path: pathlib.Path, problems: list, stats: dict):
    raw = path.read_text(errors="replace")
    text = strip_comments(raw)
    rel = path.relative_to(REPO_ROOT)
    stats["sql_files"] += 1

    # ── A. session query_tag ────────────────────────────────────────────
    if not QUERY_TAG_RE.search(text):
        problems.append(
            f"{rel}: no `ALTER SESSION SET query_tag` - every SQL session must "
            f"be tagged (AGENTS.md)."
        )
    elif ORIGIN not in raw:
        problems.append(f"{rel}: query_tag present but origin is not '{ORIGIN}'.")

    # ── B. object COMMENT ───────────────────────────────────────────────
    # Collect ALTER ... SET COMMENT targets so CTAS (which cannot take an inline
    # COMMENT) is correctly treated as covered. The name may be followed by an
    # argument list - `ALTER PROCEDURE X(VARCHAR, VARCHAR) SET COMMENT` - which is
    # the form every routing-agent tool proc uses.
    altered = {
        m.group(1).upper().strip('"')
        for m in re.finditer(
            r"ALTER\s+(?:\w+\s+){0,2}?(?:IF\s+EXISTS\s+)?"
            r"([A-Za-z0-9_.$\"]+)\s*(?:\([^)]*\))?\s+SET\s+COMMENT",
            text, re.IGNORECASE)
    }

    units = split_statements(text)
    units += [u for s, o in units for u in inner_statements(s, o)]

    for stmt, off in units:
        m = CREATE_RE.search(stmt)
        if not m:
            continue
        # Only the FIRST create in a unit is that unit's object; nested ones are
        # picked up by inner_statements().
        if m.start() > 400 and "CREATE" in stmt[:m.start()].upper():
            pass
        otype = re.sub(r"\s+", " ", m.group(1).upper())
        oname = (m.group(2) or "").strip('"')
        stats["creates"] += 1

        if otype in TYPE_EXCEPTIONS:
            stats["exempt"] += 1
            continue
        exc = next((r for fn, r in STMT_EXCEPTIONS if fn(stmt)), None)
        if exc:
            stats["exempt"] += 1
            continue
        if has_comment_clause(stmt):
            continue
        # CTAS / dynamic-SQL fallback: ALTER ... SET COMMENT elsewhere in file.
        short = oname.split(".")[-1].upper()
        if oname.upper() in altered or short in {a.split(".")[-1] for a in altered}:
            continue
        problems.append(
            f"{rel}:{line_of(text, off + m.start())}: CREATE {otype} "
            f"{oname or '<unnamed>'} has no COMMENT tracking tag (add "
            f"COMMENT = '{{\"origin\":\"{ORIGIN}\",...}}', or an "
            f"ALTER ... SET COMMENT after a CTAS)."
        )


def check_tag_schema(path: pathlib.Path, problems: list, stats: dict):
    """Class C: every tracking tag parses and carries the required schema."""
    raw = path.read_text(errors="replace")
    if ORIGIN not in raw:
        return
    rel = path.relative_to(REPO_ROOT)
    for m in TAG_RE.finditer(raw):
        tag = m.group(0)
        if ORIGIN not in tag:
            continue
        # Dynamic SQL doubles the single quotes and may concatenate host vars;
        # such a tag is not literal JSON at rest, so only its shape is checked.
        literal = tag.replace('""', '"')
        if "||" in literal:
            continue
        # Python/TS split long tags across adjacent string literals:
        #     '{"origin":"...",'
        #     '"version":{...}}'
        # which is one string at runtime. Rejoin before parsing, or every such
        # tag reads as invalid JSON.
        literal = re.sub(r"['\"]\s*\n\s*['\"]", "", literal)
        try:
            data = json.loads(literal)
        except ValueError:
            problems.append(
                f"{rel}:{line_of(raw, m.start())}: tracking tag is not valid "
                f"JSON: {literal[:90]}..."
            )
            continue
        stats["tags"] += 1
        ver, attrs = data.get("version"), data.get("attributes") or {}
        missing = []
        if not isinstance(ver, dict) or "major" not in ver or "minor" not in ver:
            missing.append('version as {"major":N,"minor":N}')
        if "is_quickstart" not in attrs:
            missing.append("attributes.is_quickstart")
        if "source" not in attrs:
            missing.append("attributes.source")
        if not str(data.get("name", "")).startswith("oss-"):
            missing.append("name with an 'oss-' prefix")
        if missing:
            problems.append(
                f"{rel}:{line_of(raw, m.start())}: tracking tag is missing "
                f"{', '.join(missing)} - it parses and looks fine, but a "
                f"consumer filtering on those fields will not match it."
            )


# ── D. untagged DDL/DML in a shell `snow sql -q` invocation ────────────────
DDL_DML_RE = re.compile(
    r"\b(CREATE|ALTER|DROP|INSERT|UPDATE|DELETE|MERGE|TRUNCATE|COPY\s+INTO|"
    r"GRANT|REVOKE|PUT|CALL|EXECUTE\s+TASK|EXECUTE\s+IMMEDIATE)\b",
    re.IGNORECASE,
)


def extract_q_payloads(text: str):
    """Yield (payload, offset) for each `snow sql ... -q "<payload>"`."""
    for m in re.finditer(r"snow\s+sql\b", text):
        window = text[m.start():m.start() + 12000]
        qm = re.search(r'-q\s+"', window)
        if not qm:
            continue
        # Walk to the unescaped closing double quote.
        i = m.start() + qm.end()
        j, n = i, len(text)
        while j < n:
            if text[j] == "\\":
                j += 2
                continue
            if text[j] == '"':
                break
            j += 1
        yield text[i:j], i


def check_shell_file(path: pathlib.Path, problems: list, stats: dict):
    text = path.read_text(errors="replace")
    rel = path.relative_to(REPO_ROOT)
    for payload, off in extract_q_payloads(text):
        stats["shell_q"] += 1
        if not DDL_DML_RE.search(payload):
            continue
        # The tag may be inline or interpolated from a variable ($TAG_SQL/$TAG).
        if QUERY_TAG_RE.search(payload) or re.search(r"\$\{?TAG", payload):
            continue
        stmt = re.sub(r"\s+", " ", payload).strip()[:100]
        problems.append(
            f"{rel}:{line_of(text, off)}: `snow sql -q` runs DDL/DML with no "
            f"query_tag in the SAME invocation (each invocation is a new "
            f"session, so an earlier tag does not carry over): {stmt}..."
        )


def main() -> int:
    problems: list[str] = []
    stats = {"sql_files": 0, "creates": 0, "exempt": 0, "tags": 0, "shell_q": 0}

    for path in iter_files(".sql"):
        check_sql_file(path, problems, stats)

    for suffix in (".sql", ".sh", ".py", ".ts", ".json"):
        for path in iter_files(suffix):
            check_tag_schema(path, problems, stats)

    for path in iter_files(".sh"):
        check_shell_file(path, problems, stats)

    if problems:
        print("check_tracking_tags: FAIL")
        for p in problems:
            print(f"  - {p}")
        print(f"\n  {len(problems)} problem(s). See AGENTS.md 'Do NOT' -> tracking tags.")
        return 1

    print(
        f"check_tracking_tags: OK ({stats['sql_files']} sql file(s) tagged, "
        f"{stats['creates']} CREATE(s) checked with {stats['exempt']} documented "
        f"platform exception(s), {stats['tags']} tag(s) schema-valid, "
        f"{stats['shell_q']} shell -q payload(s) checked)"
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())

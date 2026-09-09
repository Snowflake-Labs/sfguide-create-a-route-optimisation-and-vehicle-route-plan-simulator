#!/usr/bin/env python3
"""Fail when a synapse verb uses a JavaScript global the Snowflake proc runtime lacks.

Why this exists
---------------
Every synapse verb is compiled into a single `RETURNS OBJECT LANGUAGE JAVASCRIPT`
stored procedure (see `vendor/synapse/src/build/ddl.ts`). That runtime is a bare
ECMAScript engine: it has `JSON`, `Math`, `Date`, `Promise` and
`encodeURIComponent`, but NONE of the host APIs that a browser or Node provides -
no `URLSearchParams`, no `URL`, no `fetch`, no `Buffer`, no `process`, no timers.

The failure mode is what makes this worth a gate rather than a review note:
nothing upstream of the agent notices. `tsc` accepts the code because the repo
pulls in DOM and `@types/node` libs for the build-time half of the framework;
esbuild bundles it happily; `npx synapse deploy` creates the procedure without
complaint; and `SHOW PROCEDURES` looks perfectly healthy. The error surfaces only
when an agent calls the verb, as a bare `... is not defined` with no line number
and no `VERB_ATTEMPT` payload to explain it.

That is exactly how `deep_link` shipped broken. Its very last statement built the
query string with `new URLSearchParams()`, so the verb resolved the view label,
probed `SHOW ENDPOINTS IN SERVICE` for the ingress host, and then threw. Because
`deep_link` is the sanctioned fallback for every visual question the agent cannot
draw ("answer with the figures, then hand over a link"), its failure removed the
only honest visual path - and the agent, given an opaque internal error, told the
user to escalate a repo bug to their Fleet Ops administrator.

What it scans
-------------
Everything esbuild bundles INTO the procedure body:

* `fleet_tools/{user,ops,admin}/src/**` - the verbs and their shared helpers
* `fleet_tools/vendor/synapse/src/runtime/**` - the envelope that wraps them

Deliberately NOT scanned: the rest of `vendor/synapse/src` (the CLI, codegen and
connector run on the DEPLOYING machine under real Node, where these globals are
both present and correct), and the two apps' `ui/src` (browser code - the SA
app's own `lib/deep-link.ts` uses `URLSearchParams` legitimately).

Comments and string literals are stripped before matching, which is load-bearing
rather than tidiness: these files discuss the very APIs they must not call, and
the fix for `deep_link` is itself a comment naming `URLSearchParams` twice. A
grep would flag its own explanation. Matches also require a call or member-access
suffix, so prose-shaped identifiers and unrelated names (`url`, `APP_URL`) do not
trip it.

Usage:  python3 check_verb_js_globals.py
Exit:   0 clean, 1 a bundled source uses an unavailable global
"""

from __future__ import annotations

import re
import sys
from pathlib import Path

SKILL = Path(__file__).resolve().parent.parent

# Bundled into the procedure body, so subject to the proc runtime's limits.
SCAN_ROOTS = [
    "fleet_tools/user/src",
    "fleet_tools/ops/src",
    "fleet_tools/admin/src",
    "fleet_tools/vendor/synapse/src/runtime",
]

# name -> what to use instead. Each is matched only when followed by `(` or `.`,
# i.e. actually constructed, called or dereferenced.
BANNED: dict[str, str] = {
    "URLSearchParams": "build the query string with encodeURIComponent",
    "URL": "assemble URLs as strings; there is no URL constructor",
    "fetch": "no outbound HTTP from a verb - use a Snowflake object or the gateway",
    "XMLHttpRequest": "no outbound HTTP from a verb",
    "Buffer": "use plain strings, or Snowflake's BASE64_ENCODE/DECODE in SQL",
    "process": "no process env in a proc - pass values as verb args",
    "TextEncoder": "operate on strings directly",
    "TextDecoder": "operate on strings directly",
    "setTimeout": "no timers - a verb is synchronous from the caller's view",
    "setInterval": "no timers",
    "queueMicrotask": "no microtask scheduling",
    "structuredClone": "clone via JSON.parse(JSON.stringify(x))",
    "globalThis": "no global object to reach through",
    "require": "the bundle is self-contained; import at the top instead",
    "localStorage": "no browser storage - persist to a Snowflake table",
    "sessionStorage": "no browser storage",
    "crypto": "no WebCrypto - use a Snowflake SQL hash function",
    "AbortController": "not available",
    "FormData": "not available",
    "Blob": "not available",
    "atob": "use Snowflake's BASE64_DECODE_STRING in SQL",
    "btoa": "use Snowflake's BASE64_ENCODE in SQL",
}

PATTERN = re.compile(
    r"\b(" + "|".join(sorted(BANNED, key=len, reverse=True)) + r")\s*[(.]"
)


def strip_noise(src: str) -> str:
    """Blank out comments and string/template literals, preserving line numbers.

    Characters are replaced with spaces rather than removed so a reported line
    number still points at the real line. Regex literals are not tracked: a
    banned name inside one would be a false positive, and none exist today.
    """
    out: list[str] = []
    i, n = 0, len(src)
    while i < n:
        two = src[i : i + 2]
        if two == "//":
            nl = src.find("\n", i)
            end = n if nl == -1 else nl
            out.append(" " * (end - i))
            i = end
            continue
        if two == "/*":
            close = src.find("*/", i + 2)
            end = n if close == -1 else close + 2
            # Keep newlines so line numbers do not shift.
            out.append("".join("\n" if c == "\n" else " " for c in src[i:end]))
            i = end
            continue
        ch = src[i]
        if ch in "'\"`":
            quote = ch
            out.append(" ")
            i += 1
            while i < n:
                if src[i] == "\\":
                    out.append("  " if src[i : i + 2] != "\\\n" else " \n")
                    i += 2
                    continue
                if src[i] == quote:
                    out.append(" ")
                    i += 1
                    break
                out.append("\n" if src[i] == "\n" else " ")
                i += 1
            continue
        out.append(ch)
        i += 1
    return "".join(out)


def check(path: Path) -> list[str]:
    src = path.read_text(encoding="utf-8")
    clean = strip_noise(src)
    problems: list[str] = []
    for m in PATTERN.finditer(clean):
        name = m.group(1)
        line = clean.count("\n", 0, m.start()) + 1
        rel = path.relative_to(SKILL)
        problems.append(f"{rel}:{line}  {name} is not available - {BANNED[name]}")
    return problems


def main() -> int:
    print("Checking bundled verb sources for unavailable JavaScript globals")
    print(f"  banned globals: {len(BANNED)}")

    problems: list[str] = []
    scanned = 0
    for root in SCAN_ROOTS:
        base = SKILL / root
        if not base.exists():
            print(f"  {root:44s} absent")
            continue
        files = sorted(base.rglob("*.ts")) + sorted(base.rglob("*.mts"))
        hits = 0
        for path in files:
            found = check(path)
            hits += len(found)
            problems.extend(found)
        scanned += len(files)
        state = f"{hits} problem(s)" if hits else "clean"
        print(f"  {root:44s} {len(files):3d} file(s)  {state}")

    print()
    if scanned == 0:
        print("FAILED: verb-js-globals check found nothing to scan")
        return 1
    if problems:
        print("FAILED: verb-js-globals check")
        for p in problems:
            print(f"  - {p}")
        print()
        print(
            "  These run inside a LANGUAGE JAVASCRIPT stored procedure, which has no\n"
            "  browser or Node host APIs. The code compiles and deploys either way, so\n"
            "  the only symptom is an agent hitting '<name> is not defined' at runtime."
        )
        return 1
    print(f"PASSED: {scanned} bundled source(s) use no unavailable JavaScript global")
    return 0


if __name__ == "__main__":
    sys.exit(main())

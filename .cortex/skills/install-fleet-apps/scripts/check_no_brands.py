#!/usr/bin/env python3
"""Guard: no customer, vendor, competitor or individual names anywhere in the repo.

Every view, demo, dataset and agent answer in this solution must be brand-neutral.
That is not cosmetic. Three concrete failure modes were found in the tree when
this check was written, and each one is invisible until someone reads the output:

  * `backfill-freight-offers.sql` wrote literal freight-exchange brand names into
    the offer SOURCE column, so running it put vendor names into demo data, into
    LISTING_TEXT, onto the Freight Exchange and Backload pages, and into anything
    the agent read. Nothing failed; the demo just quietly named four vendors.
  * The shipped AISQL notebook seeded 30 offer rows with brands in both SOURCE and
    the human-readable listing text.
  * An agent tool declared its `source` parameter as a list of eight vendor names
    that the data never held, so the agent would confidently offer a user filter
    values that do not exist.

Prose in a doc is a smaller problem than any of those, but the same term list
catches all of them, so the check is repo-wide rather than scoped to SQL.

Named individuals are included deliberately. Those are a privacy matter, not a
branding one, and they must not reappear even in a reference doc.

THE ALLOWLIST IS THE INTERESTING PART
-------------------------------------
Exactly one occurrence is permitted, and it is permitted because removing it
would make the repo LESS neutral, not more:

    scripts/seed_data.sql -> DROP SCHEMA IF EXISTS FLEET_INTELLIGENCE.DHL_NTBO

That statement is the only thing that removes the vendor-named schema from an
account that still carries one. Rename or delete the line and the schema is
stranded in place forever. Naming the brand there is what gets rid of the brand.

Keep the allowlist at one entry. An allowlist that grows silently is not a gate.

Usage:
    python3 .cortex/skills/install-fleet-apps/scripts/check_no_brands.py

Exit 0 = clean, 1 = a brand reference was found (printed with file:line).
"""
from __future__ import annotations

import json
import os
import re
import sys

REPO = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..", "..", ".."))

# The term list is NOT defined here. It lives in a JSON file that the runtime
# POI filter (engine/region-source.ts) reads too, so the gate and the generator
# can never disagree about what a brand is. Duplicating the strings into
# TypeScript is what previously made this gate flag its own filter.
BRAND_TERMS_FILE = os.path.join(
    REPO, ".cortex", "skills", "install-fleet-apps", "fleet_admin_app", "ui",
    "src", "server", "studio", "engine", "brand-terms.json",
)
with open(BRAND_TERMS_FILE, "r", encoding="utf-8") as _fh:
    _TERMS_DOC = json.load(_fh)

# Distinctive multi-character names: matched case-INSENSITIVELY on word boundaries.
TERMS: list[str] = _TERMS_DOC["names"]

# All-caps acronym brands, matched CASE-SENSITIVELY. See brand-terms.json for why.
ACRONYM_TERMS: list[str] = _TERMS_DOC["acronyms"]

# "DAT" is deliberately NOT in TERMS: as a bare three-letter word it collides with
# ordinary English and identifier fragments often enough to be useless. It is
# caught in context instead.
CONTEXTUAL: list[tuple[str, str]] = [
    (r"\bDAT\b\s*(?:/|,|\bor\b)\s*(?:Truckstop|Convoy)", "DAT as a load-board name"),
    (r"(?:Truckstop|Convoy|Timocom)\s*(?:/|,|\bor\b)\s*\bDAT\b", "DAT as a load-board name"),
    (r"'DAT'", "DAT as a literal SQL value"),
]

# (path suffix, term) pairs that are allowed. See the module docstring.
# (path suffix, term) pairs that are allowed, and both entries are load-bearing.
#
#  1. seed_data.sql - the DROP SCHEMA statement is the ONLY thing that removes the
#     vendor-named schema from an account that still carries one. Rename or delete
#     it and that schema is stranded in place forever, so naming the brand there
#     is what gets rid of the brand.
#  2. brand-terms.json - the canonical term list this very check reads. A gate
#     cannot hold the definition of what it forbids without excepting it.
#
# Anything else is a real finding. Do not add a third entry to make a commit pass.
ALLOWLIST_FILES = (
    os.path.join("install-fleet-apps", "scripts", "seed_data.sql"),
    os.path.join("engine", "brand-terms.json"),
)

SKIP_DIRS = {
    ".git", "node_modules", ".next", "__pycache__", ".venv", "venv",
    "dist", "build", ".pytest_cache", ".mypy_cache",
    # Assistant transcripts and run logs, not shipped source.
    "plans", "logs",
}
SKIP_FILES = {"package-lock.json", "yarn.lock", "pnpm-lock.yaml", "check_no_brands.py"}
# Binary or generated-payload extensions where a match is meaningless.
SKIP_EXT = {
    ".parquet", ".pbf", ".osm", ".png", ".jpg", ".jpeg", ".gif", ".svg", ".ico",
    ".pdf", ".zip", ".gz", ".tar", ".woff", ".woff2", ".ttf", ".eot", ".map",
    ".pyc", ".so", ".dylib", ".wasm", ".mbtiles",
}

PATTERNS = [(t, re.compile(rf"\b{re.escape(t)}\b", re.IGNORECASE)) for t in TERMS]
PATTERNS += [(t, re.compile(rf"\b{re.escape(t)}\b")) for t in ACRONYM_TERMS]
CONTEXT_PATTERNS = [(lbl, re.compile(rx, re.IGNORECASE)) for rx, lbl in CONTEXTUAL]


def allowed(rel: str) -> bool:
    return rel.endswith(ALLOWLIST_FILES)


def main() -> int:
    findings: list[tuple[str, int, str, str]] = []
    scanned = 0

    for root, dirs, files in os.walk(REPO):
        # Prune in place so we never descend into node_modules at all - the
        # difference between a 1s check and a 20s one.
        dirs[:] = [d for d in dirs if d not in SKIP_DIRS]
        for name in files:
            if name in SKIP_FILES:
                continue
            if os.path.splitext(name)[1].lower() in SKIP_EXT:
                continue
            path = os.path.join(root, name)
            rel = os.path.relpath(path, REPO)
            if allowed(rel):
                continue
            try:
                with open(path, "r", encoding="utf-8", errors="strict") as fh:
                    lines = fh.readlines()
            except (UnicodeDecodeError, OSError):
                continue  # binary or unreadable: nothing meaningful to match
            scanned += 1
            for lineno, line in enumerate(lines, 1):
                for term, pat in PATTERNS:
                    if pat.search(line):
                        findings.append((rel, lineno, term, line.strip()[:120]))
                for label, pat in CONTEXT_PATTERNS:
                    if pat.search(line):
                        findings.append((rel, lineno, label, line.strip()[:120]))

    if findings:
        print(f"check_no_brands: FAILED - {len(findings)} brand reference(s) found\n")
        for rel, lineno, term, snippet in findings:
            print(f"  {rel}:{lineno}  [{term}]\n      {snippet}")
        print(
            "\nEvery view, demo, dataset and agent answer must be brand-neutral.\n"
            "Replace a vendor name with the capability ('external freight exchange',\n"
            "'load board'), and use the neutral source vocabulary in data:\n"
            "  DISPATCH | MARKETPLACE | PARTNER_APP | INTERNAL\n"
            "carrying any originating-system identity in SOURCE_SYSTEM instead.\n"
            "If you believe an occurrence is genuinely load-bearing, do NOT widen the\n"
            "allowlist without reading why it currently has exactly two entries."
        )
        return 1

    print(
        f"check_no_brands: OK ({scanned} text file(s) scanned, "
        f"{len(TERMS)} name(s) + {len(ACRONYM_TERMS)} case-sensitive acronym(s) "
        f"+ {len(CONTEXTUAL)} contextual pattern(s), "
        f"{len(ALLOWLIST_FILES)} documented exception(s))"
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())

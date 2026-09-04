#!/usr/bin/env python3
"""Guard: the REPO must not name a customer, vendor, competitor or individual.

SCOPE - read this before adding a term or a skip
------------------------------------------------
This check governs REPO TEXT: code, skills, docs, agent specs, and SQL that
*writes* literal values. It deliberately does NOT govern third-party data or data
exported from it. Place names in Overture Maps are real business names, and some
of them are the brands this solution must not look built for - that is accepted.
A brand may therefore arrive THROUGH the data at runtime; it must never be
AUTHORED in the repo.

That distinction is the whole design. An earlier version of this work also
filtered brand-named Overture POIs out of the generated demo pool, which was the
wrong call twice over: it silently discarded hundreds of real places (a substring
match drops anything merely containing the token, so in a region where one of
those carriers is a major operator it removes genuine logistics POIs), and a
filtered POI leaves no trace, so nobody would notice the pool had been thinned.

WHY THIS CHECK EXISTS AT ALL
----------------------------
Three concrete leaks were in the tree when it was written, and every one of them
was invisible - nothing failed, the demo just quietly named vendors:

  * `backfill-freight-offers.sql` wrote literal freight-exchange brand names into
    the offer SOURCE column, and into LISTING_TEXT, so running it put vendor
    names onto the Freight Exchange and Backload pages and into anything the
    agent read. It also contradicted the live data, which already held only the
    four neutral channel values.
  * The shipped AISQL notebook seeded 30 offer rows with brands in both SOURCE
    and the human-readable listing text.
  * An agent tool declared its `source` parameter as eight vendor names the data
    never held, so the agent would have offered users filter values that do not
    exist. Fixing it was a correctness fix as much as a neutrality one.

All three are the repo authoring a brand, which is exactly what this catches.

Named individuals are included deliberately. Those are a privacy matter, not a
branding one, and must not reappear even in a reference doc.

THE ALLOWLIST
-------------
Exactly ONE occurrence is permitted, because removing it would make the repo LESS
neutral, not more:

    scripts/seed_data.sql -> DROP SCHEMA IF EXISTS FLEET_INTELLIGENCE.DHL_NTBO

That statement is the only thing that removes the vendor-named schema from an
account that still carries one. Rename or delete the line and the schema is
stranded in place forever, so naming the brand there is what gets rid of it.

This file is skipped separately, and that skip is load-bearing rather than
incidental: a checker cannot scan the list of things it forbids.

Keep the allowlist at one entry. An allowlist that grows silently is not a gate.

Usage:
    python3 .cortex/skills/install-fleet-apps/scripts/check_no_brands.py

Exit 0 = clean, 1 = a brand reference was found (printed with file:line).
"""
from __future__ import annotations

import os
import re
import sys

REPO = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..", "..", ".."))

# Distinctive multi-character names: matched case-INSENSITIVELY on word boundaries.
TERMS: list[str] = [
    # customer and its programme / legacy entity names
    "DHL", "myDHLI", "DGF", "NTBO", "Danzas",
    # European freight exchanges
    "Timocom", "WTransnet", "Teleroute",
    # North American load boards
    "Truckstop", "Convoy", "Uber Freight", "UBER_FREIGHT",
    # named carriers used as prospect / ICP lists
    "Maersk", "Kuehne", "Nagel", "Geodis", "Dachser",
    "Gebruder Weiss", "FedEx", "Schneider National", "J.B. Hunt",
    "TheLorry", "Lalamove",
    # individuals
    "Nachtsheim", "Ahleff",
]

# All-caps acronym brands, matched CASE-SENSITIVELY.
#
# Case-insensitive matching on a three-letter acronym is worse than no check:
# `\bUPS\b` ignoring case fires on "follow-ups" (a hyphen IS a word boundary) and
# `\bDSV\b` fires on the `d3-dsv` dependency in a changelog. Three such false
# positives appeared on the first run, which is precisely how a gate teaches
# people to ignore it. These brands are always written upper-case.
ACRONYM_TERMS: list[str] = ["DSV", "XPO", "PEF", "B2P"]

# "DAT" is deliberately NOT a term: as a bare three-letter word it collides with
# ordinary English and identifier fragments often enough to be useless. It is
# caught in context instead.
CONTEXTUAL: list[tuple[str, str]] = [
    (r"\bDAT\b\s*(?:/|,|\bor\b)\s*(?:Truckstop|Convoy)", "DAT as a load-board name"),
    (r"(?:Truckstop|Convoy|Timocom)\s*(?:/|,|\bor\b)\s*\bDAT\b", "DAT as a load-board name"),
    (r"'DAT'", "DAT as a literal SQL value"),
]

# The single documented exception. See the module docstring.
ALLOWLIST_FILES = (os.path.join("install-fleet-apps", "scripts", "seed_data.sql"),)

SKIP_DIRS = {
    ".git", "node_modules", ".next", "__pycache__", ".venv", "venv",
    "dist", "build", ".pytest_cache", ".mypy_cache",
    # Assistant transcripts and run logs, not shipped source.
    "plans", "logs",
    # DATA, not repo text. Seed payloads exported from Overture legitimately carry
    # real business names; see SCOPE. Skipped by PATH as well as by extension so a
    # future CSV or JSON export cannot fail this check on data that is allowed.
    "datasets",
}

# This file holds the term list, so it cannot scan itself. Lockfiles match only
# through unrelated dependency hashes.
SKIP_FILES = {
    "check_no_brands.py",
    "package-lock.json", "yarn.lock", "pnpm-lock.yaml",
}

SKIP_EXT = {
    # Binary or generated payloads where a match is meaningless.
    ".parquet", ".pbf", ".osm", ".png", ".jpg", ".jpeg", ".gif", ".svg", ".ico",
    ".pdf", ".zip", ".gz", ".tar", ".woff", ".woff2", ".ttf", ".eot", ".map",
    ".pyc", ".so", ".dylib", ".wasm", ".mbtiles",
    # Tabular / row-oriented data exports. Same reasoning as the datasets/ skip:
    # these hold data, and brand names in data are accepted.
    ".csv", ".tsv", ".jsonl", ".ndjson",
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
            "\nThe repo must not name a customer, vendor, competitor or individual.\n"
            "Replace a vendor name with the capability ('external freight exchange',\n"
            "'load board'), and use the neutral source vocabulary when the repo\n"
            "AUTHORS a value:\n"
            "  DISPATCH | MARKETPLACE | PARTNER_APP | INTERNAL\n"
            "carrying any originating-system identity in SOURCE_SYSTEM instead.\n"
            "\n"
            "Brand names arriving through third-party map DATA are fine and are out\n"
            "of scope - if you hit this on a data export, add the path or extension\n"
            "to the skip lists rather than the allowlist.\n"
            "If you believe an occurrence is genuinely load-bearing, do NOT widen the\n"
            "allowlist without reading why it currently has exactly one entry."
        )
        return 1

    print(
        f"check_no_brands: OK ({scanned} repo text file(s) scanned, "
        f"{len(TERMS)} name(s) + {len(ACRONYM_TERMS)} case-sensitive acronym(s) "
        f"+ {len(CONTEXTUAL)} contextual pattern(s), "
        f"{len(ALLOWLIST_FILES)} documented exception; data payloads out of scope)"
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())

#!/usr/bin/env python3
"""check_marketplace_ddl_parity.py - keep the mirrored MARKETPLACE / projection
DDL in step with its runtime owner.

WHY THIS EXISTS

fleet_admin_app/ui/src/server/lib/init.ts is the RUNTIME owner of the
FLEET_INTELLIGENCE.MARKETPLACE views and the SYNTHETIC_DATASETS.UNIFIED
projections: it recreates them with CREATE OR REPLACE on every container boot.
The installer needs several of them EARLIER than that boot, so two SQL files
mirror the bodies:

  scripts/marketplace_layer.sql   6 objects SV_OFFERS reads (step 4.4)
  scripts/projection_views.sql    V_DIM_PARTNERS_CURRENT / V_FACT_PARTNER_HISTORY_CURRENT

A mirror that drifts is worse than no mirror. The installer would create one
shape at step 4.4, the semantic view would bind to it at 4.5, and then the app
boot would REPLACE it with a different shape at step 7 - so the deployment would
work until the container restarted, and the semantic view would then be bound to
columns that no longer exist. Nothing would report it: init.ts swallows every
statement failure as a WARN and continues.

This gate compares the two sides after normalising only what legitimately
differs:
  * the COMMENT's source":"sql" (installer) vs source":"app" (app boot) - the
    convention projection_views.sql already used before this gate existed
  * init.ts interpolates ${TRACK_FX} where the SQL file spells the tag out
  * whitespace and indentation (the TS bodies are indented inside a literal)
  * SQL line comments, so a comment may be added on either side

Anything else is drift and fails.
"""

from __future__ import annotations

import re
import sys
from pathlib import Path

# scripts/ -> install-fleet-apps/ -> skills/ -> .cortex/ -> repo root.
# FOUR levels. An off-by-one here has twice produced a gate in this repo that
# inspected zero files and passed, which is why OBJECTS_SEEN is asserted below.
REPO = Path(__file__).resolve().parents[4]
SKILL = REPO / ".cortex/skills/install-fleet-apps"
INIT_TS = SKILL / "fleet_admin_app/ui/src/server/lib/init.ts"
MARKETPLACE_SQL = SKILL / "scripts/marketplace_layer.sql"
PROJECTION_SQL = SKILL / "scripts/projection_views.sql"

# The objects that MUST be identical on both sides, and which file mirrors each.
MIRRORED: dict[str, Path] = {
    "FLEET_INTELLIGENCE.MARKETPLACE.VW_OFFERS": MARKETPLACE_SQL,
    "FLEET_INTELLIGENCE.MARKETPLACE.VW_PARTNERS": MARKETPLACE_SQL,
    "FLEET_INTELLIGENCE.MARKETPLACE.VW_PARTNER_HISTORY": MARKETPLACE_SQL,
    "FLEET_INTELLIGENCE.MARKETPLACE.VW_LANE_HISTORY": MARKETPLACE_SQL,
    "FLEET_INTELLIGENCE.MARKETPLACE.RATE_INDEX": MARKETPLACE_SQL,
    "FLEET_INTELLIGENCE.MARKETPLACE.VW_OFFER_ENRICHED": MARKETPLACE_SQL,
    "SYNTHETIC_DATASETS.UNIFIED.V_DIM_PARTNERS_CURRENT": PROJECTION_SQL,
    "SYNTHETIC_DATASETS.UNIFIED.V_FACT_PARTNER_HISTORY_CURRENT": PROJECTION_SQL,
}

TAG_RE = re.compile(
    r"'\{\"origin\":\"sf_sit-is-fleet\".*?\}'|\$\{TRACK_FX\}|\$\{TRACK_RO_AV\}"
)


def normalise(body: str) -> str:
    """Collapse the legitimate differences, preserve everything else."""
    # Tracking tag: differs by source":"sql" vs "app" and by TS interpolation.
    body = TAG_RE.sub("<TAG>", body)
    # SQL line comments may be added on either side independently.
    body = re.sub(r"--[^\n]*", "", body)
    # Indentation / newlines: the TS side is indented inside a template literal.
    body = re.sub(r"\s+", " ", body)
    # A trailing statement terminator exists only in the .sql file.
    return body.strip().rstrip(";").strip().upper()


def extract_from_ts(text: str, fqn: str) -> str | None:
    """Pull one CREATE ... <fqn> ... body out of an init.ts template literal."""
    m = re.search(
        r"`(CREATE\s+OR\s+REPLACE\s+(?:DYNAMIC\s+TABLE|VIEW)\s+"
        + re.escape(fqn)
        + r"\b.*?)`",
        text,
        re.S | re.I,
    )
    return m.group(1) if m else None


def extract_from_sql(text: str, fqn: str) -> str | None:
    """Pull one CREATE ... <fqn> ... statement out of a .sql file (to the ;)."""
    m = re.search(
        r"(CREATE\s+OR\s+REPLACE\s+(?:DYNAMIC\s+TABLE|VIEW)\s+"
        + re.escape(fqn)
        + r"\b.*?;)",
        text,
        re.S | re.I,
    )
    return m.group(1) if m else None


def main() -> int:
    for p in (INIT_TS, MARKETPLACE_SQL, PROJECTION_SQL):
        if not p.exists():
            print(f"FAILED: missing {p}")
            return 1

    ts_text = INIT_TS.read_text()
    sql_cache = {p: p.read_text() for p in set(MIRRORED.values())}

    seen = 0
    failures: list[str] = []

    for fqn, sql_path in MIRRORED.items():
        ts_body = extract_from_ts(ts_text, fqn)
        sql_body = extract_from_sql(sql_cache[sql_path], fqn)

        if ts_body is None:
            failures.append(
                f"{fqn}: not found in init.ts. If it was intentionally removed "
                f"from the runtime owner, drop it from MIRRORED here too - but "
                f"then {sql_path.name} is the ONLY owner and the app boot no "
                f"longer converges it."
            )
            continue
        if sql_body is None:
            failures.append(
                f"{fqn}: not found in {sql_path.name}. The installer needs this "
                f"BEFORE the app boots (step 4.4 / 2.5); leaving it to init.ts "
                f"is the ordering defect this mirror exists to prevent."
            )
            continue

        seen += 1
        if normalise(ts_body) != normalise(sql_body):
            failures.append(
                f"{fqn}: DRIFT between init.ts and {sql_path.name}.\n"
                f"      init.ts : {normalise(ts_body)[:160]}\n"
                f"      {sql_path.name:<22}: {normalise(sql_body)[:160]}"
            )
        else:
            print(f"  ok   {fqn} ({sql_path.name})")

    # A gate that inspected nothing is not a gate. Both extractors are regex
    # based, so a refactor of either file could silently match zero objects.
    if seen == 0:
        print(
            "FAILED: 0 objects compared - the extractors matched nothing.\n"
            "  This gate passed without checking anything. Fix the extraction "
            "before trusting a green result."
        )
        return 1

    print()
    if failures:
        print(f"FAILED: {len(failures)} of {len(MIRRORED)} mirrored object(s) diverged.")
        for f in failures:
            print(f"  - {f}")
        print(
            "\n  init.ts is the RUNTIME owner and REPLACES these on every boot, so "
            "drift\n  means the deployment silently changes shape when the "
            "container restarts."
        )
        return 1

    print(f"PASSED: {seen}/{len(MIRRORED)} mirrored objects identical to init.ts.")
    return 0


if __name__ == "__main__":
    sys.exit(main())

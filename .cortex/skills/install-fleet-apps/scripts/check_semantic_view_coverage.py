#!/usr/bin/env python3
"""Gate: the semantic views answer each use case's plain question themselves.

WHAT WENT WRONG. Asked one question per use case on a fresh install, the agent
worked around three gaps in fleet_sa_app/app/semantic_views.sql:
  - "Which 5 vehicles drove the most km?" - SV_FLEET_OPS had no vehicle_id even
    though VW_TRIPS carries it, so the agent hit a tool error and fell back to
    raw SQL, then told the user the governed view could not answer.
  - "Which facilities have the most SLA breaches?" - SV_DWELL_ANALYTICS did not
    bind FLEET_APP.DWELL.VW_SLA_ALERTS, so the agent approximated a breach as
    "dwell > 15 min": 1,211 restaurant breaches against 7,415 real ones.
  - Route deviation: DISTANCE_DEVIATION_PCT was commented "Distance deviation
    percent" with no scale, so the agent multiplied it by 100 and told the user
    to divide the stored value.

RULE A - SV_FLEET_OPS exposes trips.vehicle_id.
RULE B - SV_DWELL_ANALYTICS binds VW_SLA_ALERTS as a child of sessions and
         exposes its severity and a breach count.
RULE C - every *_pct member defined as a bare stored column states its scale in
         its COMMENT (percent units, 0-100, 0-1 or fraction).
"""
import pathlib
import re
import sys

APP = pathlib.Path(__file__).resolve().parent.parent / "fleet_sa_app" / "app"
SCALE = re.compile(r"percent units|ALREADY a percentage|\(0-100\)|\(0-1\)|fraction", re.I)


def view(text: str, name: str) -> str:
    m = re.search(rf"CREATE OR REPLACE SEMANTIC VIEW \S+\.{name}\b(.*?)\n;", text, re.S)
    return m.group(1) if m else ""


def main() -> int:
    errs = []
    sv = (APP / "semantic_views.sql").read_text()

    fo = view(sv, "SV_FLEET_OPS")
    if not re.search(r"^\s*,?\s*trips\.vehicle_id AS VEHICLE_ID\b", fo, re.M):
        errs.append("RULE A SV_FLEET_OPS does not expose trips.vehicle_id")

    dw = view(sv, "SV_DWELL_ANALYTICS")
    if not re.search(r"\b(\w+) AS FLEET_APP\.DWELL\.VW_SLA_ALERTS\b", dw):
        errs.append("RULE B SV_DWELL_ANALYTICS does not bind FLEET_APP.DWELL.VW_SLA_ALERTS")
    else:
        alias = re.search(r"\b(\w+) AS FLEET_APP\.DWELL\.VW_SLA_ALERTS\b", dw).group(1)
        if not re.search(rf"\b{alias}\([^)]*SESSION_ID[^)]*\) REFERENCES sessions\(", dw):
            errs.append("RULE B SLA alerts are not related to sessions, so breaches cannot group by site")
        if not re.search(rf"^\s*,?\s*{alias}\.sla_status AS SLA_STATUS\b", dw, re.M):
            errs.append("RULE B SV_DWELL_ANALYTICS does not expose the per-session sla_status")
        if not re.search(rf"^\s*,?\s*{alias}\.\w+ AS COUNT\(", dw, re.M):
            errs.append("RULE B SV_DWELL_ANALYTICS has no breach-count metric on the SLA alerts")

    for f in sorted(APP.glob("semantic_views*.sql")):
        lines = f.read_text().splitlines()
        for i, ln in enumerate(lines):
            m = re.match(r"^\s*,?\s*\w+\.(\w+_pct) AS ([A-Z_]+)\b(?!\s*\()(.*)$", ln)
            if not m:
                continue
            rest = m.group(3) + " " + (lines[i + 1] if i + 1 < len(lines) else "")
            if not SCALE.search(rest):
                errs.append(f"RULE C {f.name}:{i + 1} {m.group(1)} is a stored percentage with no scale in its COMMENT")

    for e in errs:
        print("FAIL", e)
    if errs:
        return 1
    print("PASSED: semantic views expose vehicle, SLA breach and percentage-scale answers.")
    return 0


if __name__ == "__main__":
    sys.exit(main())

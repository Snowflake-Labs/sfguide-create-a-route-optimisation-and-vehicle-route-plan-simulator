#!/usr/bin/env python3
"""Which use cases a missing data layer breaks, and how to rebuild it.

One walk over every nested `data.query` in app-views.json, joined to the SA
app's repair-map.json. Three consumers:

  * the installer summary (--warn-log / --view-report): a guarded builder that
    returned 'WARN: ...' used to leave a bare "3.5 analytic | WARN" with no
    reason and no affected views, so a customer found the dead Site Impact page
    before anyone read the log
  * view_catalog.sql generation (required_schemas): the agent catalog records
    what each use case needs, so the agent stops recommending a view whose
    layer was never built
  * check_view_availability.py: asserts the SA app's lib/view-deps.ts walks
    queries the same way

Usage:
  layer_impact.py [--warn-log F ...] [--warn-glob '/tmp/ifa_*.log' --since EPOCH] \\
                  [--view-report /tmp/ifa_view_report.json] [--region R] [--markdown]
Exit 0 always (it reports; the installer decides severity). Prints nothing when
there is nothing degraded.
"""
from __future__ import annotations

import argparse
import json
import pathlib
import re
import sys

SKILL = pathlib.Path(__file__).resolve().parents[1]
APP_VIEWS = SKILL / "fleet_sa_app" / "app" / "app-views.json"
REPAIR_MAP = SKILL / "fleet_sa_app" / "ui" / "src" / "lib" / "repair-map.json"
DB = "FLEET_APP"

# A rendered result row from `snow sql`: "| WARN: ... |". The SQL source is
# echoed too, so only pipe-led rows count (same rule as install step 3.5).
WARN_ROW = re.compile(r"^\|\s*(WARN:.*?)\s*\|?\s*$")


def collect_query_nodes(view) -> list[dict]:
    """Every node carrying data.query, labelled by its id when it has one.

    Labels prefer `id` over the positional path because inserting one layer
    renumbers every path after it, which would silently move an expectations
    entry onto a different query.
    """
    found = []

    def walk(node, path):
        if isinstance(node, dict):
            data = node.get("data")
            if isinstance(data, dict) and isinstance(data.get("query"), str):
                found.append({
                    "label": node.get("id") or node.get("name") or path or "root",
                    "path": path,
                    "query": data["query"],
                    "params": data.get("params") or {},
                })
            for key, val in node.items():
                walk(val, ("%s.%s" % (path, key)) if path else key)
        elif isinstance(node, list):
            for i, val in enumerate(node):
                walk(val, "%s[%d]" % (path, i))

    walk(view, "")
    return found


def data_refs(sql: str, db: str = DB) -> list[tuple[str, str, bool]]:
    out = []
    for m in re.finditer(r"\b%s\.([A-Za-z0-9_]+)\.([A-Za-z0-9_]+)" % db, sql):
        is_fn = bool(re.match(r"\s*\(", sql[m.end():]))
        out.append((m.group(1).upper(), m.group(2).upper(), is_fn))
    return out


def view_schemas(view, db: str = DB) -> list[str]:
    return sorted({s for n in collect_query_nodes(view) for s, _, _ in data_refs(n["query"], db)})


def view_refs(view, db: str = DB) -> list[tuple[str, str, bool]]:
    """(schema, object, is_function) in first-seen order; a name used as a
    function anywhere is a function. Mirrors viewDataRefs in view-deps.ts."""
    seen: dict[tuple[str, str], bool] = {}
    for n in collect_query_nodes(view):
        for s, o, fn in data_refs(n["query"], db):
            seen[(s, o)] = seen.get((s, o), False) or fn
    return [(s, o, fn) for (s, o), fn in seen.items()]


def schema_probes(views: dict, db: str = DB) -> dict[str, tuple[str, bool]]:
    """schema -> (object, is_function) to probe it with. Mirrors schemaProbes()
    in view-deps.ts, so the app and the agent catalog probe the same object."""
    probes: dict[str, tuple[str, bool]] = {}
    for v in views.values():
        for s, o, fn in view_refs(v, db):
            prev = probes.get(s)
            if prev is None or (prev[1] and not fn):
                probes[s] = (o, fn)
    return probes


def required_objects(view, probes: dict[str, tuple[str, bool]], db: str = DB) -> list[str]:
    """Probe spec per dependency: 'rows:FQN' must exist and return a row,
    'exists:FQN' must only exist, 'function:FQN' must exist as a function.
    Pack views declare theirs in pack-views.json (requires / requiresExists)."""
    if "requires" in view or "requiresExists" in view:
        return (["rows:%s" % f for f in view.get("requires") or []]
                + ["exists:%s" % f for f in view.get("requiresExists") or []])
    out = []
    for s in view_schemas(view, db):
        o, fn = probes[s]
        out.append("%s:%s.%s.%s" % ("function" if fn else "rows", db, s, o))
    return out


def load_views() -> dict:
    return json.loads(APP_VIEWS.read_text())


def load_entries() -> list[dict]:
    return json.loads(REPAIR_MAP.read_text())["entries"]


def entry_for_schema(schema: str, entries: list[dict]) -> dict | None:
    ref = "%s.%s." % (DB, schema)
    return next((e for e in entries if ref.startswith(e["prefix"].upper())), None)


def entry_for_warn(text: str, entries: list[dict]) -> dict | None:
    """Map a builder's WARN line to its layer by the builder it names."""
    up = text.upper()
    best = None
    for e in entries:
        names = re.findall(r"\b(BUILD_[A-Z0-9_]+)", " ".join([e["action"], *(e.get("fix") or [])]))
        if any(n in up for n in names):
            # prefer the entry whose own action names the builder (Location's
            # fix also mentions BUILD_CATCHMENT as a prerequisite)
            own = re.findall(r"\b(BUILD_[A-Z0-9_]+)", e["action"])
            if any(n in up for n in own):
                return e
            best = best or e
    if best:
        return best
    # Builders whose WARN names the layer in prose, not by procedure.
    for word, layer in (("LOCATION DIAGNOSTICS", "location"), ("BUILD_LOCATION_", "location"),
                        ("CATCHMENT", "catchment"), ("GEOGRAPHIC COVERAGE", "catchment"),
                        ("SOURCING", "sourcing")):
        if word in up:
            return next((e for e in entries if e["layer"] == layer), None)
    return None


def views_reading(entry: dict, views: dict) -> list[dict]:
    pfx = entry["prefix"].upper()
    hits = []
    for vid, v in views.items():
        if any(("%s.%s." % (DB, s)).startswith(pfx) for s in view_schemas(v)):
            hits.append({"id": vid, "label": display_text(v.get("label", vid)),
                         "headline": display_text((v.get("useCase") or {}).get("headline", ""))})
    return hits


def display_text(text):
    """Fill {{labels.*}} tokens the way the app does, so the summary names
    'Live Vehicle Operations', not 'Live {{labels.entity}} Operations'."""
    if not isinstance(text, str) or "{{" not in text:
        return text
    from build_view_catalog import interpolate  # lazy: it imports this module
    try:
        cfg = json.loads((SKILL / "fleet_sa_app" / "app" / "app-config.json").read_text())
    except (OSError, ValueError):
        return text
    return interpolate(text, cfg.get("display") or {})


# Same two shapes lib/missing-dependency.ts matches (measured on Snowflake).
MISSING_OBJ = re.compile(
    r"(?:(?:Object|Schema|Table|View|Function)\s+'([^']+)'\s+does not exist"
    r"|Unknown user-defined (?:table )?function\s+([A-Za-z0-9_$.\"]+))", re.I)


def entry_for_object(text: str, entries: list[dict]) -> dict | None:
    """The layer owning the object a view-check error names, if any."""
    m = MISSING_OBJ.search(text or "")
    if not m:
        return None
    name = (m.group(1) or m.group(2) or "").replace('"', "").upper()
    return next((e for e in entries if name.startswith(e["prefix"].upper())), None)


def fix_steps(entry: dict) -> list[str]:
    """Runnable steps; @FILE/@PACK actions become the snow command that runs
    them (mirrors fixSteps in lib/missing-dependency.ts)."""
    if entry.get("fix"):
        return list(entry["fix"])
    a = entry["action"]
    if a.startswith("@PACK:"):
        return ["snow sql -c <connection> -f .cortex/skills/install-fleet-apps/fleet_sa_app/app/"
                "packs/fleet/%s/setup.sql --enable-templating NONE" % a[6:]]
    if a.startswith("@FILE:"):
        return ["snow sql -c <connection> -f .cortex/skills/install-fleet-apps/scripts/%s "
                "--enable-templating NONE" % a[6:]]
    return [a + ";"]


def run_logs(pattern: str, since: float) -> list[str]:
    """Logs matching `pattern` written by THIS run. A /tmp log left by an
    earlier install would otherwise report that run's failures as this one's."""
    import glob
    import os
    return sorted(p for p in glob.glob(pattern) if os.path.getmtime(p) >= since)


def warn_lines(paths: list[str]) -> list[str]:
    out = []
    for p in paths:
        try:
            text = pathlib.Path(p).read_text(errors="replace")
        except OSError:
            continue
        for line in text.splitlines():
            m = WARN_ROW.match(line.strip())
            if m and m.group(1) not in out:
                out.append(m.group(1))
    return out


def degraded(warn_paths: list[str], view_report: str | None, since: float = 0.0) -> list[dict]:
    """One item per broken layer: label, reasons, views it breaks, fix."""
    views, entries = load_views(), load_entries()
    items: dict[str, dict] = {}

    def item(entry):
        key = entry["layer"]
        if key not in items:
            items[key] = {"layer": key, "label": entry.get("label", key), "reasons": [],
                          "views": views_reading(entry, views),
                          "fix": fix_steps(entry),
                          "note": entry.get("note", "")}
        return items[key]

    unmapped = []
    for w in warn_lines(warn_paths):
        e = entry_for_warn(w, entries)
        if e:
            item(e)["reasons"].append(w)
        else:
            unmapped.append(w)

    import os
    if view_report and os.path.exists(view_report) and os.path.getmtime(view_report) < since:
        view_report = None  # left by an earlier run
    if view_report:
        try:
            rep = json.loads(pathlib.Path(view_report).read_text())
        except (OSError, ValueError):
            rep = None
        rows = rep.get("results", rep) if isinstance(rep, dict) else (rep or [])
        for r in rows if isinstance(rows, list) else []:
            status = r.get("status")
            if status not in ("ERROR", "EMPTY"):
                continue
            msg = "view check: %s %s %s" % (r.get("view"), r.get("area"), status)
            # An ERROR is attributed to the layer owning the object it names -
            # never to every schema the view reads (that blamed the Core
            # contract, and 11 views, for one missing Location object). An
            # EMPTY area only corroborates a layer a WARN already flagged:
            # empty is often legitimate for a region.
            if status == "ERROR":
                e = entry_for_object(r.get("detail", ""), entries)
                if e is None:
                    continue
                targets = [e]
            else:
                v = views.get(r.get("view"))
                targets = [e for s in (view_schemas(v) if v else [])
                           for e in [entry_for_schema(s, entries)] if e and e["layer"] in items]
            for e in targets:
                it = item(e)
                if msg not in it["reasons"]:
                    it["reasons"].append(msg)
    out = list(items.values())
    if unmapped:
        out.append({"layer": "unmapped", "label": "Other best-effort steps", "reasons": unmapped,
                    "views": [], "fix": [], "note": ""})
    return out


def render(items: list[dict], markdown: bool, region: str | None = None) -> str:
    if not items:
        return ""
    for it in items:
        it["fix"] = [f.replace("{region}", region or "<region>") for f in it["fix"]]
    lines = []
    for it in items:
        views = ", ".join(v["label"] for v in it["views"]) or "no shipped view"
        if markdown:
            lines.append("- **%s** breaks: %s" % (it["label"], views))
            lines += ["  - reason: %s" % r[:300] for r in it["reasons"][:4]]
            if it["fix"]:
                lines.append("  - fix: `%s`" % "` then `".join(it["fix"]))
        else:
            lines.append("   !! %s -> breaks: %s" % (it["label"], views))
            lines += ["      reason: %s" % r[:220] for r in it["reasons"][:3]]
            if it["fix"]:
                lines.append("      fix:    %s" % "  then  ".join(it["fix"]))
    return "\n".join(lines)


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--warn-log", action="append", default=[])
    ap.add_argument("--warn-glob", help="also read every log matching this glob ...")
    ap.add_argument("--since", type=float, default=0.0, help="... modified at/after this epoch")
    ap.add_argument("--view-report")
    ap.add_argument("--markdown", action="store_true")
    ap.add_argument("--json", action="store_true")
    ap.add_argument("--region", help="fills {region} in the fix")
    a = ap.parse_args()
    logs = list(a.warn_log) + (run_logs(a.warn_glob, a.since) if a.warn_glob else [])
    items = degraded(logs, a.view_report, a.since)
    if a.json:
        print(json.dumps(items, indent=1))
    else:
        text = render(items, a.markdown, a.region)
        if text:
            print(text)
    return 0


if __name__ == "__main__":
    sys.exit(main())

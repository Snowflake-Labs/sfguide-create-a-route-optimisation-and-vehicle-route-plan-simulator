#!/usr/bin/env python3
"""
Deploy-all installer for the data-contract domain packs.

Reads packs/manifest.yaml, orders packs by their inter-pack `depends_on`, and for
each pack (optionally) regenerates setup.sql from data-model + entity-mapping, then
applies it with `snow sql`. All pack DDL is CREATE OR REPLACE / IF NOT EXISTS, so
the install is idempotent: re-running converges with no diff.

Usage:
  # install every pack, in dependency order, on the default connection
  python3 install.py

  # regenerate each setup.sql from its model+mapping before applying
  python3 install.py --regenerate

  # only a subset (dependencies are still ordered, not auto-pulled)
  python3 install.py --only dwell,route_optimization

  # show the plan without running anything
  python3 install.py --dry-run

  # probe mode: report which packs resolve with data (the surfacing-gate signal)
  python3 install.py --probe
"""
import argparse, os, subprocess, sys

HERE = os.path.dirname(os.path.abspath(__file__))
PACKS_DIR = os.path.dirname(HERE)                 # .../app/packs
FLEET_DIR = os.path.join(PACKS_DIR, "fleet")
SUBSTRATE_DIR = os.path.join(PACKS_DIR, "_substrate")  # neutral zero-copy substrate(s)
MANIFEST = os.path.join(PACKS_DIR, "manifest.yaml")
GENERATOR = os.path.join(HERE, "generate.py")
APP_DIR = os.path.dirname(PACKS_DIR)              # .../app
# Hand-maintained, app-level contract SQL (NOT pack-generated). The per-session
# scope-arg data contract: UNIFIED F_*_SCOPED UDTFs
# + the neutral FLEET_APP.UNIFIED_FLEET.F_VW_*_SCOPED wrappers the consumer binds
# to. Applied AFTER the unified_fleet pack (it owns FLEET_APP.UNIFIED_FLEET).
CONTRACT_SQL = os.path.join(APP_DIR, "scoped_contract.sql")
CONTRACT_PACK = "unified_fleet"

try:
    import yaml
except ImportError:
    sys.exit("PyYAML required: pip install pyyaml")


def pack_dir(name):
    """Resolve a pack's source directory. Most packs live under packs/fleet/<name>,
    but the standalone `starter` pack (own STARTER_APP DB) lives at packs/<name>.
    Prefer packs/fleet/<name> when present, else fall back to packs/<name>."""
    fleet = os.path.join(FLEET_DIR, name)
    if os.path.isdir(fleet):
        return fleet
    flat = os.path.join(PACKS_DIR, name)
    if os.path.isdir(flat):
        return flat
    return fleet


def load_manifest():
    with open(MANIFEST) as f:
        return yaml.safe_load(f)["packs"]


def topo(packs):
    """Order packs so every pack follows its depends_on. Stable on declaration order."""
    by_name = {p["name"]: p for p in packs}
    out, state = [], {}

    def visit(name, stack):
        if state.get(name) == 1:
            return
        if state.get(name) == 0:
            sys.exit(f"Cycle in pack depends_on: {' -> '.join(stack + [name])}")
        p = by_name.get(name)
        if p is None:
            sys.exit(f"Pack '{name}' listed as a dependency but not in manifest")
        state[name] = 0
        for dep in p.get("depends_on", []) or []:
            visit(dep, stack + [name])
        state[name] = 1
        out.append(p)

    for p in packs:
        visit(p["name"], [])
    return out


def run(cmd):
    print("  $ " + " ".join(cmd))
    return subprocess.run(cmd, capture_output=True, text=True)


def regenerate(pack):
    name = pack["name"]
    d = pack_dir(name)
    model = os.path.join(d, "data-model.yaml")
    mapping = os.path.join(d, "entity-mapping.yaml")
    out = os.path.join(d, "setup.sql")
    if not (os.path.exists(model) and os.path.exists(mapping)):
        print(f"  [skip regen] {name}: no data-model/entity-mapping")
        return
    r = run([sys.executable, GENERATOR, "--model", model, "--mapping", mapping, "--out", out])
    if r.returncode != 0:
        sys.exit(f"generate failed for {name}:\n{r.stderr}")
    print("  " + r.stdout.strip())


def apply_pack(pack, conn):
    """Apply a pack's setup.sql. Best-effort: returns True on success, False on
    failure (missing setup.sql, or upstream demo-data not yet present). The
    manifest surfacing-gate is the runtime authority on which packs are live, so a
    pack that cannot install yet (e.g. dwell before the dwell-analysis demo seeds
    FLEET_INTELLIGENCE.DWELL_ANALYSIS.CONFIG) must NOT abort the whole install."""
    setup = os.path.join(pack_dir(pack["name"]), "setup.sql")
    if not os.path.exists(setup):
        print(f"  [skip] {pack['name']}: setup.sql missing - run with --regenerate")
        return False
    cmd = ["snow", "sql", "-f", setup]
    if conn:
        cmd += ["-c", conn]
    r = run(cmd)
    if r.returncode != 0:
        # Surface the first error line so the cause (usually a missing upstream
        # object from a not-yet-run demo) is visible, but keep going.
        err = (r.stdout + "\n" + r.stderr).strip().splitlines()
        hint = next((l.strip() for l in err if "does not exist" in l.lower() or "error" in l.lower()), "see snow output")
        print(f"  [FAIL] {pack['name']}: {hint}")
        return False
    print(f"  [ok] {pack['name']} applied")
    return True


def regenerate_repoint(pack):
    """Emit <pack>/sv_repoint.sql: a single EXECUTE IMMEDIATE block that rebinds the
    pack's semantic_views (from manifest) onto its FLEET_APP views. Deterministic from
    model + mapping + manifest, so it is committed as the durable reproducibility
    artifact. NOTE: assumes the SV already exists; this rebinds base tables, it does
    NOT author the SV. Idempotent (no-op REPLACE once already on FLEET_APP)."""
    svs = pack.get("semantic_views") or []
    name = pack["name"]
    d = pack_dir(name)
    model = os.path.join(d, "data-model.yaml")
    mapping = os.path.join(d, "entity-mapping.yaml")
    out = os.path.join(d, "sv_repoint.sql")
    if not svs:
        return None
    if not (os.path.exists(model) and os.path.exists(mapping)):
        print(f"  [skip repoint-gen] {name}: no data-model/entity-mapping")
        return None
    r = run([sys.executable, GENERATOR, "--model", model, "--mapping", mapping,
             "--out", out, "--sv-repoint", ",".join(svs)])
    if r.returncode != 0:
        sys.exit(f"repoint generate failed for {name}:\n{r.stderr}")
    print("  " + r.stdout.strip())
    return out


def repoint_pack(pack, conn):
    if not (pack.get("semantic_views")):
        return
    out = os.path.join(pack_dir(pack["name"]), "sv_repoint.sql")
    if not os.path.exists(out):
        sys.exit(f"{pack['name']}: sv_repoint.sql missing - run with --regenerate")
    cmd = ["snow", "sql", "-f", out]
    if conn:
        cmd += ["-c", conn]
    r = run(cmd)
    if r.returncode != 0:
        sys.exit(f"sv-repoint failed for {pack['name']}:\n{r.stdout}\n{r.stderr}")
    print(f"  [ok] {pack['name']} SV-repoint applied ({','.join(pack['semantic_views'])})")


def apply_contract(conn):
    """Apply the app-level per-session scope-arg data contract (scoped_contract.sql).
    Idempotent (CREATE OR REPLACE FUNCTION). Runs after the unified_fleet pack so the
    FLEET_APP.UNIFIED_FLEET schema it targets already exists."""
    if not os.path.exists(CONTRACT_SQL):
        print(f"  [skip contract] {CONTRACT_SQL} not found")
        return
    cmd = ["snow", "sql", "-f", CONTRACT_SQL]
    if conn:
        cmd += ["-c", conn]
    r = run(cmd)
    if r.returncode != 0:
        sys.exit(f"scope-arg contract apply failed:\n{r.stdout}\n{r.stderr}")
    print("  [ok] scope-arg data contract applied (scoped_contract.sql)")


def probe_pack(pack, conn):
    probe = pack.get("probe")
    if not probe:
        return (pack["name"], None)
    cmd = ["snow", "sql", "-q", f"SELECT COUNT(*) AS N FROM {probe}"]
    if conn:
        cmd += ["-c", conn]
    r = subprocess.run(cmd, capture_output=True, text=True)
    if r.returncode != 0:
        return (pack["name"], "ERROR")
    digits = [int(s) for s in r.stdout.replace("|", " ").split() if s.isdigit()]
    return (pack["name"], (digits[-1] if digits else 0))


def apply_substrate(conn):
    """Apply every _substrate/*.sql (e.g. neutral-sf.sql) BEFORE the pack loop.
    These create the neutral zero-copy views (SYNTHETIC_DATASETS.NEUTRAL.*) that
    the starter pack maps from. Idempotent (CREATE OR REPLACE VIEW). Skipped
    silently if the dir is absent. Roles referenced by the substrate's GRANTs are
    pre-created by the orchestrator before this runs."""
    if not os.path.isdir(SUBSTRATE_DIR):
        return
    for fn in sorted(os.listdir(SUBSTRATE_DIR)):
        if not fn.endswith(".sql"):
            continue
        path = os.path.join(SUBSTRATE_DIR, fn)
        cmd = ["snow", "sql", "-f", path]
        if conn:
            cmd += ["-c", conn]
        r = run(cmd)
        if r.returncode != 0:
            sys.exit(f"substrate apply failed for {fn}:\n{r.stdout}\n{r.stderr}")
        print(f"  [ok] substrate {fn} applied")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--connection", "-c", default=None, help="snow CLI connection name")
    ap.add_argument("--regenerate", action="store_true", help="regenerate setup.sql (and sv_repoint.sql when --sv-repoint) from model+mapping before applying")
    ap.add_argument("--only", default=None, help="comma-separated subset of pack names")
    ap.add_argument("--dry-run", action="store_true", help="print the ordered plan, do nothing")
    ap.add_argument("--probe", action="store_true", help="report which packs resolve with data (surfacing signal)")
    ap.add_argument("--sv-repoint", action="store_true", help="after applying each pack, rebind its semantic_views (manifest) onto its FLEET_APP views (idempotent)")
    ap.add_argument("--skip-contract", action="store_true", help="do NOT apply the per-session scope-arg data contract (scoped_contract.sql) after the unified_fleet pack")
    args = ap.parse_args()

    packs = topo(load_manifest())
    if args.only:
        want = {s.strip() for s in args.only.split(",") if s.strip()}
        packs = [p for p in packs if p["name"] in want]

    if args.probe:
        print("Pack data presence (probe COUNT):")
        for p in packs:
            name, n = probe_pack(p, args.connection)
            mark = "present" if isinstance(n, int) and n > 0 else ("EMPTY" if n == 0 else str(n))
            print(f"  {name:20s} {mark:>10}  ({p.get('probe','-')})")
        return

    print(f"Install order ({len(packs)} packs): " + " -> ".join(p["name"] for p in packs))
    if args.dry_run:
        for p in packs:
            dep = (" depends_on=" + ",".join(p["depends_on"])) if p.get("depends_on") else ""
            print(f"  {p['name']:20s} {p['app_schema']}{dep}")
        return

    # Neutral substrate (SYNTHETIC_DATASETS.NEUTRAL.*) the starter pack maps from.
    # Applied once, before any pack setup.sql.
    print("== neutral substrate (_substrate/*.sql) ==")
    apply_substrate(args.connection)

    installed, failed = [], []
    for p in packs:
        print(f"== {p['name']} ({p['app_schema']}) ==")
        if args.regenerate:
            regenerate(p)
            if args.sv_repoint:
                regenerate_repoint(p)
        ok = apply_pack(p, args.connection)
        if ok:
            installed.append(p["name"])
            if args.sv_repoint:
                repoint_pack(p, args.connection)
        else:
            failed.append(p["name"])
    # Per-session scope-arg data contract: apply once after packs, only when the
    # unified_fleet pack (owner of FLEET_APP.UNIFIED_FLEET) is in the install set.
    if not args.skip_contract and any(p["name"] == CONTRACT_PACK for p in packs):
        print("== scope-arg data contract (scoped_contract.sql) ==")
        apply_contract(args.connection)
    print("done.")
    print(f"  installed: {', '.join(installed) or '(none)'}")
    if failed:
        print(f"  not-yet-resolved (best-effort; surface after their demo data exists): {', '.join(failed)}")


if __name__ == "__main__":
    main()

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
MANIFEST = os.path.join(PACKS_DIR, "manifest.yaml")
GENERATOR = os.path.join(HERE, "generate.py")

try:
    import yaml
except ImportError:
    sys.exit("PyYAML required: pip install pyyaml")


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
    d = os.path.join(FLEET_DIR, name)
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
    setup = os.path.join(FLEET_DIR, pack["name"], "setup.sql")
    if not os.path.exists(setup):
        sys.exit(f"{pack['name']}: setup.sql missing - run with --regenerate or generate it first")
    cmd = ["snow", "sql", "-f", setup]
    if conn:
        cmd += ["-c", conn]
    r = run(cmd)
    if r.returncode != 0:
        sys.exit(f"apply failed for {pack['name']}:\n{r.stdout}\n{r.stderr}")
    print(f"  [ok] {pack['name']} applied")


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


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--connection", "-c", default=None, help="snow CLI connection name")
    ap.add_argument("--regenerate", action="store_true", help="regenerate setup.sql from model+mapping before applying")
    ap.add_argument("--only", default=None, help="comma-separated subset of pack names")
    ap.add_argument("--dry-run", action="store_true", help="print the ordered plan, do nothing")
    ap.add_argument("--probe", action="store_true", help="report which packs resolve with data (surfacing signal)")
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

    for p in packs:
        print(f"== {p['name']} ({p['app_schema']}) ==")
        if args.regenerate:
            regenerate(p)
        apply_pack(p, args.connection)
    print("done.")


if __name__ == "__main__":
    main()

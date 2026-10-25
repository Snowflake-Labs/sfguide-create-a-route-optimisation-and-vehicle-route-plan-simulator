#!/usr/bin/env python3
"""Guard: a best-effort layer that did not build must be NAMED in the install
summary, with the views it breaks and the command that rebuilds it.

What happened (sfseeurope-idoukas_aws1, 2026-10-09): BUILD_LOCATION_DIAGNOSTICS
could not run, its guard returned 'WARN: ...', the summary said only
"3.5 analytic | WARN", and a customer found the dead Site Impact page first.

Rules (fixtures are in snow sql's real log shape: echoed source + result table):
  A  a WARN result row maps to its layer and names Site Impact, Closure Impact
     and BUILD_LOCATION_DIAGNOSTICS()
  A2 the WARN that names no procedure ("Location diagnostics skipped: ...",
     returned when the region has no addresses) still maps to Location
  B  the builder's own echoed `RETURN 'WARN: ...'` source is NOT a failure: the
     clean fixture reports nothing (an unanchored match warned on every run)
  C  a log older than the run is ignored (--since), so a stale /tmp log cannot
     report a previous install's failure as this one's
  D  install_fleet_apps.sh feeds the run's logs (--warn-glob + --since START_TS
     + the view report) to layer_impact.py and prints the result in BOTH the
     console summary and the friction log (comments stripped)
  E  a view-check ERROR is blamed on the layer owning the object it NAMES, not
     on every schema the view reads (one missing Location object used to
     blame the Core contract and 11 views), and labels carry no {{tokens}}
  F  a WARN cell that snow wrapped across several lines (80 columns even into
     a file - fixture captured from snow itself) is read WHOLE, through its
     SQLERRM tail
  H  the console finale names each non-OK step (NONOK_STEPS) and never points
     at "the status table", which is written only to the friction log
  I  step 9's WARN prints the failing view lines from /tmp/ifa_verify.log, not
     just the tally (EMPTY=1 named no view)
  J  both pipelines EXECUTED under `set -euo pipefail` with nothing to match
     (a clean run) still reach the finale
  G  the installer reads the region from FLEET_INTELLIGENCE.CATCHMENT.CONFIG and
     passes it as --region, so fixes are copy-pasteable

Usage:  python3 .cortex/skills/install-fleet-apps/scripts/check_install_warn_surfacing.py
Exit:   0 clean, 1 violation
"""
from __future__ import annotations

import json
import os
import pathlib
import re
import shutil
import subprocess
import sys
import tempfile

HERE = pathlib.Path(__file__).resolve().parent
HELPER = HERE / "layer_impact.py"
INSTALLER = HERE / "install_fleet_apps.sh"
WARN_FIX = HERE / "fixtures" / "ifa_analytic_location_warn.snowsql.txt"
CLEAN_FIX = HERE / "fixtures" / "ifa_analytic_clean.snowsql.txt"
WRAPPED_FIX = HERE / "fixtures" / "ifa_analytic_location_warn_wrapped.snowsql.txt"

failures: list[str] = []


def run(*args: str) -> str:
    p = subprocess.run([sys.executable, str(HELPER), *args], capture_output=True, text=True, timeout=60)
    if p.returncode != 0:
        failures.append("helper exited %d: %s" % (p.returncode, p.stderr.strip()[-200:]))
    return p.stdout


# A
out = run("--warn-log", str(WARN_FIX))
for needle in ("Site Impact", "Closure Impact", "BUILD_LOCATION_DIAGNOSTICS()"):
    if needle not in out:
        failures.append("A a Location WARN row does not name %r in the summary" % needle)

# A2
with tempfile.TemporaryDirectory() as d:
    f = pathlib.Path(d) / "skipped.txt"
    # A result block in the shape snow prints (see the wrapped fixture).
    f.write_text("+---+\n| anonymous block |\n|---|\n"
                 "| WARN: Location diagnostics skipped: configured region lacks Overture POIs or addresses. |\n"
                 "+---+\n")
    if "Site Impact" not in run("--warn-log", str(f)):
        failures.append("A2 the 'Location diagnostics skipped' WARN does not map to Location")

# B
if run("--warn-log", str(CLEAN_FIX)).strip():
    failures.append("B the builder's echoed RETURN 'WARN:' source was reported as a failure")

# C
with tempfile.TemporaryDirectory() as d:
    stale = pathlib.Path(d) / "ifa_analytic.log"
    shutil.copy(WARN_FIX, stale)
    old = stale.stat().st_mtime - 3600
    os.utime(stale, (old, old))
    if run("--warn-glob", str(pathlib.Path(d) / "ifa_*.log"), "--since", str(old + 60)).strip():
        failures.append("C a log older than the run was reported as this run's failure")

# D
sh = "\n".join(l for l in INSTALLER.read_text().splitlines() if not l.lstrip().startswith("#"))
args_m = re.search(r"DEGRADED_ARGS=\(([^)]*)\)", sh)
args = args_m.group(1) if args_m else ""
for flag, why in (("--warn-glob", "the run's logs"), ('--since "$START_TS"', "the run start"),
                  ("--view-report", "step 9's view report")):
    if flag not in args:
        failures.append("D installer does not pass %s (%s) to layer_impact.py" % (flag, why))
if not re.search(r'echo\s+"\$DEGRADED_MD"', sh):
    failures.append("D the friction log never prints DEGRADED_MD")
if not re.search(r'echo\s+"\$DEGRADED_TXT"', sh):
    failures.append("D the console summary never prints DEGRADED_TXT")

# E
with tempfile.TemporaryDirectory() as d:
    rep = pathlib.Path(d) / "report.json"
    rep.write_text(json.dumps([{
        "view": "site_impact", "area": "areas.metrics", "status": "ERROR",
        "detail": "Object 'FLEET_APP.LOCATION.VW_STORES' does not exist or not authorized."}]))
    out = run("--view-report", str(rep))
    if "Location diagnostics" not in out:
        failures.append("E a view-check ERROR naming a Location object is not blamed on Location")
    if "Core data contract" in out:
        failures.append("E a view-check ERROR blamed every schema the view reads (Core contract)")
    if "{{" in out:
        failures.append("E the summary prints raw {{label}} tokens")

# F
wrapped = run("--warn-log", str(WRAPPED_FIX))
if "REGIONAL_ADDRESSES' does not exist or not authorized." not in " ".join(wrapped.split()):
    failures.append("F a wrapped WARN cell lost its tail (only the first wrapped line was read)")

# G
if not re.search(r"SELECT REGION FROM FLEET_INTELLIGENCE\.CATCHMENT\.CONFIG", sh):
    failures.append("G installer does not read the region from CATCHMENT.CONFIG")
if not re.search(r"DEGRADED_ARGS\+=\(--region", sh):
    failures.append("G installer does not pass --region to layer_impact.py")

# H
if "see the status table" in sh:
    failures.append("H the console points at a status table it never prints (it is in the friction log only)")
if not re.search(r'echo " not OK: \$\{NONOK_STEPS\}', sh):
    failures.append("H the console finale does not name the non-OK steps (NONOK_STEPS)")

# I
if not re.search(r"sed -n '/\^FAILED:/,\$p' /tmp/ifa_verify\.log[^\n]*\n[^\n]*note \"[^\"]*failing: ", sh):
    failures.append("I step 9 WARN does not name the failing views from /tmp/ifa_verify.log")

# J
# EXECUTE both new pipelines under the installer's own `set -euo pipefail` with
# inputs that match nothing (a clean run). Cycle 3 of the 2026-10-25 e2e loop:
# the NONOK_STEPS grep matched nothing, set -e killed the installer before the
# finale and a fully clean install exited 1.
nonok = re.search(r"^NONOK_STEPS=.*$", sh, re.M)
step9 = re.search(r"^\s*sed -n '/\^FAILED:/,\$p' /tmp/ifa_verify\.log.*\\\n.*$", sh, re.M)
if not nonok or not step9:
    failures.append("J could not find the NONOK_STEPS / step-9 failing-view lines to execute")
else:
    with tempfile.TemporaryDirectory() as d:
        log = pathlib.Path(d) / "verify.log"
        log.write_text("OK=10\n")
        script = ("set -euo pipefail\nnote() { echo \"$*\"; }\n"
                  "STEP_STATUS=('1 a|OK' '9 verify-views|OK')\n"
                  + nonok.group(0) + "\n"
                  + step9.group(0).replace("/tmp/ifa_verify.log", str(log)) + "\n"
                  + "echo REACHED_FINALE\n")
        p = subprocess.run(["bash", "-c", script], capture_output=True, text=True, timeout=30)
        if "REACHED_FINALE" not in p.stdout:
            failures.append("J a clean run aborts under set -euo pipefail before the finale (rc=%d)" % p.returncode)

if failures:
    print("install warn surfacing: %d violation(s)" % len(failures))
    for f in failures:
        print("  " + f)
    sys.exit(1)
print("install warn surfacing: OK")

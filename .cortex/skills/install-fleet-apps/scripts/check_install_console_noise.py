#!/usr/bin/env python3
"""Gate: the engine provisioning step does not flood the installer console.

WHAT WENT WRONG. A fresh install printed 11,513 console lines; 11,436 came from
provision_engine.sh loading 9 engine SQL modules through run_sql_module.sh
without QUIET=1, which tees every statement and its result box. SHOW SERVICES
in the default table format rendered one character per line, and the closing
banner told the customer to "Re-run install_fleet_apps.sh" in the middle of the
run that was about to wait for the engine itself.

RULE A - every run_sql_module.sh call in provision_engine.sh sets QUIET=1.
RULE B - in QUIET mode run_sql_module.sh still prints the SQL error lines on
         failure (otherwise QUIET would hide WHY a module failed).
RULE C - SHOW SERVICES printed to the console uses --format CSV.
RULE D - the "Re-run install_fleet_apps.sh" advice is gated on FLEET_INSTALLER,
         and install_fleet_apps.sh passes FLEET_INSTALLER=1 to provision_engine.sh.
RULE E - the install summary prints AUTO_SUSPEND_SECS=0 as no-suspend: the
         reader used `or "-"`, which turned 0 into "idle-suspend -s".
RULE F - "endpoint still provisioning" advice prints only when a URL is empty;
         it was unconditional and pointed at a command shown only in that case.
"""
import pathlib
import re
import sys

S = pathlib.Path(__file__).resolve().parent


def code(name: str) -> str:
    text = (S / name).read_text()
    lines = [re.sub(r"(^|\s)#.*$", "", ln) for ln in text.splitlines()]
    return "\n".join(lines).replace("\\\n", " ")


def main() -> int:
    errs = []
    pe, inst, rsm = code("provision_engine.sh"), code("install_fleet_apps.sh"), code("run_sql_module.sh")

    for ln in pe.splitlines():
        if "run_sql_module.sh" in ln and not re.search(r"\bQUIET=1\b", ln):
            errs.append(f"RULE A provision_engine.sh runs a module without QUIET=1: {ln.strip()}")

    fail = re.search(r'if sed .*?\n(.*?)\n\s*exit 2', rsm, re.S)
    if not fail or not re.search(r'QUIET.*?grep -E', fail.group(1), re.S):
        errs.append("RULE B run_sql_module.sh does not print the SQL errors on a QUIET failure")

    for ln in pe.splitlines():
        if "SHOW SERVICES" in ln and "snow sql" in ln and "--format" not in ln and ">/dev/null" not in ln:
            errs.append(f"RULE C SHOW SERVICES printed as a default table: {ln.strip()[:120]}")

    rerun = [m.start() for m in re.finditer(r"Re-run install_fleet_apps\.sh", pe)]
    for pos in rerun:
        before = pe[max(0, pos - 300):pos]
        if not re.search(r'if \[ "\$\{FLEET_INSTALLER:-0\}" = "1" \].*\belse\b', before, re.S):
            errs.append("RULE D 'Re-run install_fleet_apps.sh' is printed unconditionally")
    calls = [ln for ln in inst.splitlines()
             if re.search(r'\bbash\s+"\$SCRIPTS/provision_engine\.sh"', ln)
             and "ONLY_IMAGES=1" not in ln]
    for ln in calls:
        if "FLEET_INSTALLER=1" not in ln:
            errs.append(f"RULE D install_fleet_apps.sh calls provision_engine.sh without FLEET_INSTALLER=1: {ln.strip()[:120]}")
    if not calls:
        errs.append("RULE D no foreground provision_engine.sh call found in install_fleet_apps.sh")

    pw = (S / "prewarm_engine.sh").read_text()
    if re.search(r'auto_suspend_secs"\)\s*or\b', pw):
        errs.append("RULE E prewarm_engine.sh collapses AUTO_SUSPEND_SECS=0 into a missing value")
    if not re.search(r'^\s*0\)\s*printf .*no-suspend', pw, re.M):
        errs.append("RULE E prewarm_engine.sh does not print AUTO_SUSPEND_SECS=0 as no-suspend")

    hint = re.search(r'^(.*)\n.*echo "   4\. .*provisioning', inst, re.M)
    if not hint or not re.search(r'if \[ -z "\$\{SA_URL:-\}" \]', hint.group(1)):
        errs.append("RULE F endpoint-provisioning advice is printed even when both URLs resolved")

    for e in errs:
        print("FAIL", e)
    if errs:
        return 1
    print("PASSED: engine provisioning keeps the installer console readable.")
    return 0


if __name__ == "__main__":
    sys.exit(main())

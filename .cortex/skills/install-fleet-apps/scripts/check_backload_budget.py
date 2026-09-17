#!/usr/bin/env python3
"""Enforce that TOOL_BACKLOAD_SOLVE stays BOUNDED and stays VEHICLE-SCOPABLE.

WHY THIS GATE EXISTS
--------------------
`TOOL_BACKLOAD_SOLVE` used to have no wall-clock ceiling of any kind, and the
agent had no way to ask about ONE vehicle. Together those two gaps produced a
call that never came back.

The arithmetic, all of it measured in this repo or read off the deployed
gateway spec:

    strategy 'ensemble'          -> 3 road families, run SEQUENTIALLY
    solveWithShear               -> up to MAX_UNROUTABLE_RETRIES+1 = 17 attempts
    gateway matrix pre-compute   -> 45s ceiling  (ORS_TIMEOUT_MATRIX_PRECOMPUTE)
    gateway VROOM post          -> 300s ceiling (deliberate, must not be lowered)
    -------------------------------------------------------------------------
    upper bound                  3 x 17 x 345s  =~ 4.9 HOURS

against `STATEMENT_TIMEOUT_IN_SECONDS = 172800` (48h, the account default) on
the routing warehouse. Nothing cancelled it. Measured warm runs are already
75.8s / 168.6s / 270.1s, every one of them past interactive patience, and a
COLD continental graph misses the 45s pre-compute and drops into the gateway's
per-leg fallback - which the gateway's own source calls "a multi-minute
apparent hang at the OPTIMIZATION TVF caller".

Two things fix it, and this gate exists because BOTH are invisible when broken:

  * P_TIME_BUDGET_S, checked inside solveWithShear AND between families. A
    between-families-only check is NOT a ceiling: one family can burn the entire
    budget by itself, which is exactly the 17-attempt loop above.
  * P_TRAILER_ID, so a question about a named truck solves that truck. Without
    it the only way to narrow was `max_vehicles=1`, which is ordered by free
    time and therefore returns the LONGEST-IDLE vehicle - it answers about a
    different truck and says nothing about having done so. That is worse than
    slow, because it is silently wrong.

Removing either one leaves a proc that still compiles, still returns correct
numbers on a small warm region, and still passes every other gate in this repo.
The regression only shows up as a hang on a cold or continental region, which is
indistinguishable from an infrastructure problem. Hence a gate, not a review
note.

WHAT IT CHECKS
--------------
A. The proc declares P_TRAILER_ID and P_TIME_BUDGET_S, and the stale lower-arity
   signatures are DROPped before the CREATE. Every argument is defaulted, so
   without the drops Snowflake keeps the old procedure and rejects the new one
   with "ambiguous PROCEDURE overloading" - the file fails on every account that
   installed an earlier version.
B. The budget is enforced INSIDE the shear loop, not only between families, and
   the check happens BEFORE the engine call (after it, the time is already
   spent). Also that budget exhaustion is REPORTED (degraded / a typed reason),
   not swallowed.
C. P_TRAILER_ID actually reaches the trailer feed SQL and is bound, not
   concatenated; and a named vehicle that resolves to nothing is its own
   VEHICLE_NOT_FOUND rather than being folded into NO_FEED.
D. The eligible-pairs read is REGION-SCOPED. Unscoped it returned the whole
   account (measured 29,047 rows across two regions) and pulled another
   region's eligibility chips into this plan's baseline scan.
E. The verb exposes both args, and the app's exact-match arity map agrees with
   the verb. `/api/tool` rejects a mismatch with a 400, so a stale arity breaks
   the cockpit rather than degrading it.
F. The agent orchestration teaches trailer_id for a named vehicle AND warns off
   max_vehicles=1, in the SAME bullet as backload_solve. Adjacency is required
   on purpose: a "somewhere in the file" check false-passes off a neighbouring
   bullet, which has already happened in this repo.

Exit 0 clean, 1 on any finding. Read-only.
"""
from __future__ import annotations

import json
import re
import sys
from pathlib import Path

SKILL_DIR = Path(__file__).resolve().parent.parent
REPO = SKILL_DIR.parent.parent.parent
if not (REPO / ".cortex").is_dir():  # pragma: no cover - guards a wrong-parents bug
    print(f"FAIL: REPO resolved to {REPO}, which has no .cortex/ - "
          f"the path arithmetic is wrong and every rule below would inspect nothing.")
    sys.exit(1)

PROC_SQL = REPO / ".cortex" / "skills" / "routing-agent" / "references" / "deploy-agent.sql"
VERB_TS = SKILL_DIR / "fleet_tools" / "user" / "src" / "procs" / "backload_solve.ts"
TOOL_ROUTE = SKILL_DIR / "fleet_sa_app" / "ui" / "src" / "app" / "api" / "tool" / "route.ts"
APP_CONFIG = SKILL_DIR / "fleet_sa_app" / "app" / "app-config.json"
AGENT_SPECS = [
    SKILL_DIR / "fleet_sa_app" / "app" / "agent-spec.json",
    SKILL_DIR / "fleet_sa_app" / "app" / "super-agent-spec.json",
]

PROC = "FLEET_INTELLIGENCE.ROUTING_TOOLS.TOOL_BACKLOAD_SOLVE"


def proc_body(sql: str) -> str | None:
    """The JS body of TOOL_BACKLOAD_SOLVE only.

    Scoped deliberately: deploy-agent.sql holds 9 TOOL_* procedures and several
    of them have their own shear loops and their own $$ blocks, so a whole-file
    regex would happily satisfy every rule here from a DIFFERENT procedure.
    """
    m = re.search(
        r"CREATE OR REPLACE PROCEDURE\s+" + re.escape(PROC) + r"\s*\(.*?\n\$\$\n(.*?)\n\$\$;",
        sql,
        re.DOTALL,
    )
    return m.group(1) if m else None


def proc_signature(sql: str) -> str | None:
    m = re.search(
        r"CREATE OR REPLACE PROCEDURE\s+" + re.escape(PROC) + r"\s*\((.*?)\)\s*\nRETURNS",
        sql,
        re.DOTALL,
    )
    return m.group(1) if m else None


def shear_loop(body: str) -> str | None:
    """The body of solveWithShear's retry loop."""
    m = re.search(r"function solveWithShear\s*\([^)]*\)\s*\{(.*?)\n    \}", body, re.DOTALL)
    return m.group(1) if m else None


def strip_js_comments(text: str) -> str:
    text = re.sub(r"/\*.*?\*/", lambda m: "\n" * m.group(0).count("\n"), text, flags=re.DOTALL)
    return re.sub(r"//[^\n]*", "", text)


def orchestration_of(spec_path: Path) -> str | None:
    try:
        spec = json.loads(spec_path.read_text(encoding="utf-8"))
    except Exception:
        return None
    node = spec.get("instructions")
    if isinstance(node, dict) and isinstance(node.get("orchestration"), str):
        return node["orchestration"]
    if isinstance(spec.get("orchestration"), str):
        return spec["orchestration"]
    return None


def backload_bullet(orch: str) -> str | None:
    """The single '- ... -> backload_solve.' bullet, not the whole document.

    Bullets are newline-separated '- ' entries. Returning the bullet is what
    makes rule F an ADJACENCY check: the trailer_id guidance has to live with
    the tool it is about, not thousands of characters away next to some other
    verb that happens to mention vehicles.
    """
    for line in orch.split("\n"):
        if line.lstrip().startswith("-") and "-> backload_solve" in line:
            return line
    return None


def main() -> int:
    findings: list[str] = []
    checked = 0  # vacuity counter: a rule that inspected nothing is not a rule

    # ---------------------------------------------------------------- rule A
    if not PROC_SQL.exists():
        print(f"FAIL: {PROC_SQL} is missing; the proc this gate guards is gone.")
        return 1
    sql = PROC_SQL.read_text(encoding="utf-8", errors="replace")
    sig = proc_signature(sql)
    body = proc_body(sql)
    if sig is None or body is None:
        print(f"FAIL: could not locate {PROC} (signature={sig is not None}, "
              f"body={body is not None}). Every rule below would be vacuous.")
        return 1
    checked += 1

    for arg in ("P_TRAILER_ID", "P_TIME_BUDGET_S"):
        if arg not in sig:
            findings.append(
                f"[A] {PROC} no longer declares {arg}. "
                + ("Without P_TRAILER_ID a question about one named vehicle can only be "
                   "narrowed with max_vehicles=1, which returns the LONGEST-IDLE vehicle "
                   "and silently answers about a different truck."
                   if arg == "P_TRAILER_ID" else
                   "Without P_TIME_BUDGET_S the ensemble is bounded only by the 48h "
                   "statement timeout: 3 families x 17 attempts x 345s =~ 4.9 hours.")
            )
    # Stale signatures must be dropped, or the CREATE is rejected outright.
    n_args = len([a for a in sig.split(",") if a.strip()])
    drops = re.findall(r"DROP PROCEDURE IF EXISTS\s+" + re.escape(PROC) + r"\s*\(([^)]*)\)", sql)
    drop_arities = {len([a for a in d.split(",") if a.strip()]) for d in drops}
    for lower in range(5, n_args):
        if lower not in drop_arities:
            findings.append(
                f"[A] no `DROP PROCEDURE IF EXISTS {PROC}(...)` for the {lower}-argument "
                f"signature. All arguments are defaulted, so CREATE OR REPLACE with "
                f"{n_args} does NOT replace a {lower}-arg version: Snowflake keeps both and "
                f"rejects the new one with \"ambiguous PROCEDURE overloading\", failing the "
                f"file on every account that installed an earlier build."
            )

    # ---------------------------------------------------------------- rule B
    clean = strip_js_comments(body)
    loop = shear_loop(clean)
    if loop is None:
        findings.append(
            "[B] solveWithShear's retry loop could not be located, so the in-loop "
            "deadline check cannot be verified. If the function was renamed, update "
            "this gate - do not leave the loop unguarded."
        )
    else:
        checked += 1
        if "budgetExhausted" not in loop:
            findings.append(
                "[B] the shear retry loop does not check `budgetExhausted()`. A "
                "between-families check alone is NOT a ceiling: this loop runs up to "
                f"MAX_UNROUTABLE_RETRIES+1 attempts, each allowed 45s+300s by the "
                "gateway, so ONE family can consume over 90 minutes on its own."
            )
        else:
            # Before the call, not after: afterwards the time is already spent.
            call_at = loop.find("solveOnce(")
            check_at = loop.find("budgetExhausted")
            if call_at != -1 and check_at > call_at:
                findings.append(
                    "[B] the shear loop checks `budgetExhausted()` AFTER calling "
                    "solveOnce(). Checking after the engine call cannot prevent the "
                    "attempt that overruns - it only reports it once the time is gone."
                )
    if "budgetExhausted" in clean and not re.search(r"\bbudgetHit\b", clean):
        findings.append(
            "[B] the budget is checked but exhaustion is never recorded (`budgetHit`), so a "
            "truncated run cannot be distinguished from a complete one. Silently returning "
            "a partial plan as SUCCESS is how 'ensemble' collapses to a great-circle scan "
            "and gets presented as a live road solve."
        )
    if "TIME_BUDGET_EXCEEDED" not in clean:
        findings.append(
            "[B] no TIME_BUDGET_EXCEEDED reason. A run that solved nothing because the "
            "clock ran out must not return SUCCESS-with-no-proposals: that tells the "
            "caller no backload exists for a plan that was never attempted."
        )

    # ---------------------------------------------------------------- rule C
    feed = re.search(r"trailers\s*=\s*rowsOf\((.*?)\n        \);?", clean, re.DOTALL)
    feed_src = feed.group(1) if feed else None
    if feed_src is None:
        # Fall back to the region-scoped trailer read by its view name.
        m = re.search(r"(VW_TRAILERS_GEO.*?)\n            \[", clean, re.DOTALL)
        feed_src = m.group(1) if m else None
    if feed_src is None:
        findings.append("[C] the trailer feed read could not be located; trailer scoping is unverifiable.")
    else:
        checked += 1
        if "trailerId" not in feed_src:
            findings.append(
                "[C] the trailer feed does not narrow on `trailerId`, so P_TRAILER_ID is "
                "accepted and then ignored - the proc solves the whole region while "
                "reporting it answered about one vehicle."
            )
        if re.search(r"TRAILER_ID\s*=\s*'\"?\s*\+\s*trailerId", feed_src):
            findings.append(
                "[C] `trailerId` is CONCATENATED into the trailer feed SQL instead of bound. "
                "Unlike the integer caps it is caller-supplied text, so it must be a `?` bind."
            )
    if "VEHICLE_NOT_FOUND" not in clean:
        findings.append(
            "[C] no VEHICLE_NOT_FOUND reason. Folding an unknown vehicle into NO_FEED "
            "reports a typo, or a vehicle parked in another region, as 'this region has no "
            "idle vehicles' - which sends the caller to inspect the fleet instead of the id."
        )

    # ---------------------------------------------------------------- rule D
    elig = re.search(r"eligible\s*=\s*rowsOf\((.*?)\n            \[", clean, re.DOTALL)
    if elig is None:
        findings.append("[D] the eligible-pairs read could not be located; region scoping is unverifiable.")
    else:
        checked += 1
        esrc = elig.group(1)
        if "VW_CANDIDATES_SCORED" not in esrc:
            findings.append("[D] the eligible-pairs read no longer reads VW_CANDIDATES_SCORED; re-check this gate.")
        elif "REGION" not in esrc:
            findings.append(
                "[D] the eligible-pairs read over VW_CANDIDATES_SCORED is NOT region-scoped. "
                "That view spans every loaded region, so `WHERE ELIGIBLE = TRUE` alone returns "
                "the whole account (measured 29,047 rows across two regions) and mixes another "
                "region's eligibility chips into this plan. The trailer and load feeds are "
                "already scoped, so this read is the leak."
            )

    # ---------------------------------------------------------------- rule E
    if not VERB_TS.exists():
        findings.append("[E] fleet_tools/user/src/procs/backload_solve.ts is missing.")
    else:
        checked += 1
        vsrc = VERB_TS.read_text(encoding="utf-8", errors="replace")
        # The callTool argument list is the ONLY place that matters, and it must be
        # extracted before the per-arg checks below. `args.trailer_id` also appears
        # in the `params` object used for the solve cache key, so a whole-file
        # substring test PASSES while the proc is being handed a literal null -
        # measured: that exact mutation slipped through the first version of this
        # rule.
        call = re.search(r"callTool\(ctx\.conn,\s*Procs\.backloadSolve,\s*\[(.*?)\]", vsrc, re.DOTALL)
        call_args = call.group(1) if call else ""
        for arg in ("trailer_id", "time_budget_s"):
            if not re.search(r"^\s*" + arg + r":\s*t$", vsrc, re.MULTILINE) and f"{arg}: t" not in vsrc:
                findings.append(
                    f"[E] the backload_solve verb does not declare `{arg}`. The proc accepts "
                    f"it but no agent can reach it, which is the same as not having it."
                )
            if not re.search(r"\bargs\." + arg + r"\b", call_args):
                findings.append(
                    f"[E] the verb declares `{arg}` but does not forward `args.{arg}` in its "
                    f"callTool argument list, so the proc receives a constant on every call. "
                    f"The arg appears in the schema and in the cache-key params, so this is "
                    f"invisible without reading the CALL itself."
                )
        # Arity is matched EXACTLY by /api/tool, so a stale map is a hard 400.
        verb_arity = len([a for a in call_args.split(",") if a.strip()]) if call else None
        if verb_arity is None:
            findings.append("[E] could not read the verb's callTool argument list; arity unverifiable.")
        else:
            for path, getter in (
                (TOOL_ROUTE, lambda s: re.search(r"backload_solve:\s*(\d+)", s)),
                (APP_CONFIG, lambda s: re.search(r'"backload_solve":\s*(\d+)', s)),
            ):
                if not path.exists():
                    continue
                m = getter(path.read_text(encoding="utf-8", errors="replace"))
                if not m:
                    findings.append(f"[E] {path.name}: no backload_solve arity entry found.")
                elif int(m.group(1)) != verb_arity:
                    findings.append(
                        f"[E] {path.name} declares backload_solve arity {m.group(1)} but the "
                        f"verb passes {verb_arity} args. /api/tool compares arity EXACTLY and "
                        f"returns 400, so every cockpit solve fails outright."
                    )

    # ---------------------------------------------------------------- rule F
    for spec in AGENT_SPECS:
        if not spec.exists():
            continue
        orch = orchestration_of(spec)
        if orch is None:
            findings.append(f"[F] {spec.name}: no instructions.orchestration string found.")
            continue
        bullet = backload_bullet(orch)
        if bullet is None:
            findings.append(
                f"[F] {spec.name}: no orchestration bullet routes to backload_solve, so none "
                f"of the guidance below can be checked for adjacency."
            )
            continue
        checked += 1
        if "trailer_id" not in bullet:
            findings.append(
                f"[F] {spec.name}: the backload_solve bullet never mentions `trailer_id`. "
                f"A working arg the agent is not told about does not get used - the model "
                f"keeps solving the whole region to answer about one truck."
            )
        if "max_vehicles=1" not in bullet:
            findings.append(
                f"[F] {spec.name}: the backload_solve bullet does not warn against "
                f"`max_vehicles=1` for a named vehicle. Offering trailer_id is not enough: "
                f"max_vehicles=1 LOOKS like the way to scope to one vehicle and instead "
                f"returns the longest-idle one, so the answer is about the wrong truck."
            )

    if checked == 0:
        print("FAIL: this gate inspected NOTHING - every path resolved empty. "
              "A vacuous pass is worse than no gate.")
        return 1

    if findings:
        print("FAIL: TOOL_BACKLOAD_SOLVE is unbounded or no longer vehicle-scopable\n")
        for f in findings:
            print(f"  {f}")
        print(f"\n{len(findings)} finding(s) across {checked} inspected surface(s). "
              f"Unbounded, the ensemble's ceiling is ~4.9h against a 48h statement timeout.")
        return 1

    print(f"PASS: TOOL_BACKLOAD_SOLVE is time-bounded (in-loop + per-family), "
          f"vehicle-scopable, region-scoped, and the arity map agrees with the verb "
          f"({checked} surfaces inspected)")
    return 0


if __name__ == "__main__":
    sys.exit(main())

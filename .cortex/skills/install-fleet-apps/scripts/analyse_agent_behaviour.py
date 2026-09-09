#!/usr/bin/env python3
"""analyse_agent_behaviour.py - what the deployed agents actually did.

Read-only report over FLEET_INTELLIGENCE.SEMANTIC_OPS (semantic_views_behaviour.sql).
Creates nothing, changes nothing, issues only SELECT.

WHY THIS EXISTS
Every other check in this repo proves an agent is well FORMED. check_agent_verb_coverage
asserts each verb is documented, check_verb_js_globals asserts it can compile,
validate_app_views asserts the panels return rows. None of them asks whether the agents
BEHAVE well once deployed, and that gap hid three real defects at once on tib85385:

  * deep_link failed 4 calls out of 4 with "URLSearchParams is not defined", while every
    static gate was green. The agent, handed an opaque internal error, told the user to
    escalate a repo bug to their administrator.
  * run_sql was the most-used verb, and several calls queried VW_DWELL_SESSIONS and
    TRIP_DEVIATION_ANALYSIS directly - both already modelled by query_dwell and
    query_route_deviation. The instruction to prefer the governed path exists in BOTH the
    agent spec and run_sql's own tool description, and lost anyway.
  * 34 of 38 declared verbs had never been called, so a deep_link-class runtime fault
    could sit undetected in any of them.

None of that was visible without hand-querying three audit tables, which is exactly why
it went unnoticed for as long as it did.

WHAT IT IS NOT
Not a gate. Findings here are signals for a human, not build failures: an unexercised
verb is a testing gap rather than a bug, and a run_sql that legitimately answers an
unmodelled question is correct behaviour. Wiring this into the installer would turn
useful signal into noise. check_agent_eval_thresholds.py remains the CI gate.

Exit codes: 0 nothing notable, 2 findings to look at, 1 a query failed.

Usage:
    python3 scripts/analyse_agent_behaviour.py -c <connection>
    python3 scripts/analyse_agent_behaviour.py -c <connection> --days 7
"""
import argparse
import json
import subprocess
import sys

SCHEMA = "FLEET_INTELLIGENCE.SEMANTIC_OPS"

TRACK = ('{"origin":"sf_sit-is-fleet","name":"oss-install-fleet-apps",'
         '"version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,'
         '"source":"sql","component":"agent-behaviour-report"}}')


def run_sql(connection: str, sql: str) -> list | None:
    """Execute one statement. Returns rows, or None on failure.

    None and [] are deliberately different: [] is a healthy empty result (nothing
    to report), None is a broken query. Collapsing them would let a permission
    error read as a clean bill of health, which is the failure mode this whole
    report exists to avoid.

    The query_tag is prepended in the SAME invocation because each `snow sql` call
    is a new session, so a tag set earlier does not carry over. That makes the CLI
    emit one result set per statement, hence the data[-1].
    """
    tag_sql = f"ALTER SESSION SET query_tag = '{TRACK}';"
    result = subprocess.run(
        ["snow", "sql", "-c", connection, "--format", "json",
         "-q", f"{tag_sql} {sql}", "--enable-templating", "NONE"],
        capture_output=True, text=True,
    )
    if result.returncode != 0:
        print(f"  SQL FAILED: {result.stderr.strip()[:400]}", file=sys.stderr)
        return None
    try:
        data = json.loads(result.stdout)
    except json.JSONDecodeError:
        print(f"  unparseable output: {result.stdout[:200]}", file=sys.stderr)
        return None
    if data and isinstance(data[0], list):
        return data[-1]
    return data


def h(title: str) -> None:
    print(f"\n{title}")
    print("-" * len(title))


def table(rows: list, cols: list) -> None:
    """Print rows as aligned columns. Values are truncated for readability only."""
    if not rows:
        print("  (none)")
        return
    widths = {c: max(len(c), *(len(str(r.get(c, ''))[:60]) for r in rows)) for c in cols}
    print("  " + "  ".join(c.ljust(widths[c]) for c in cols))
    for r in rows:
        print("  " + "  ".join(str(r.get(c, ''))[:60].ljust(widths[c]) for c in cols))


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("-c", "--connection", required=True)
    ap.add_argument("--days", type=int, default=30,
                    help="window for turn latency and cost stats (default 30)")
    args = ap.parse_args()
    conn = args.connection

    findings = 0
    failed = 0

    print("=" * 72)
    print("AGENT BEHAVIOUR REPORT")
    print("=" * 72)

    # ---- 1. verb failures -------------------------------------------------
    # First, because a verb that cannot succeed is the most actionable thing here
    # and the least likely to be noticed: the agent absorbs the error and
    # improvises a reply, so the user sees a bad answer rather than a crash.
    h("1. Verb failures")
    rows = run_sql(conn, f"""
        SELECT VERB, BUNDLE, COUNT(*) AS FAILURES,
               MAX(ERROR_CODE) AS ERROR_CODE,
               MAX(LEFT(ERROR_MESSAGE, 90)) AS SAMPLE_MESSAGE
        FROM {SCHEMA}.VW_AGENT_VERB_CALLS
        WHERE OUTCOME = 'error'
        GROUP BY VERB, BUNDLE
        ORDER BY FAILURES DESC
        LIMIT 20
    """)
    if rows is None:
        failed += 1
    elif rows:
        table(rows, ["VERB", "BUNDLE", "FAILURES", "ERROR_CODE", "SAMPLE_MESSAGE"])
        findings += 1
    else:
        print("  no failed verb attempts")

    # ---- 2. verbs that have NEVER succeeded -------------------------------
    # The deep_link signature. Distinguished from a plain failure count because a
    # verb that sometimes works is a bug in one path, whereas one that has never
    # once worked is almost certainly broken outright.
    h("2. Verbs called but never once successful")
    rows = run_sql(conn, f"""
        SELECT BUNDLE, VERB, CALLS, CALLS_ERROR, LAST_CALL_AT
        FROM {SCHEMA}.VW_AGENT_VERB_COVERAGE
        WHERE ONLY_EVER_FAILED
        ORDER BY CALLS DESC
    """)
    if rows is None:
        failed += 1
    elif rows:
        table(rows, ["BUNDLE", "VERB", "CALLS", "CALLS_ERROR", "LAST_CALL_AT"])
        print("  ^ every call failed. Treat as broken until proven otherwise.")
        findings += 1
    else:
        print("  none - every called verb has succeeded at least once")

    # ---- 3. coverage ------------------------------------------------------
    h("3. Verb coverage")
    rows = run_sql(conn, f"""
        SELECT BUNDLE,
               COUNT(*) AS DECLARED,
               COUNT_IF(WAS_CALLED) AS EXERCISED,
               COUNT_IF(NOT WAS_CALLED) AS NEVER_CALLED
        FROM {SCHEMA}.VW_AGENT_VERB_COVERAGE
        GROUP BY BUNDLE ORDER BY BUNDLE
    """)
    if rows is None:
        failed += 1
    else:
        table(rows, ["BUNDLE", "DECLARED", "EXERCISED", "NEVER_CALLED"])
        never = run_sql(conn, f"""
            SELECT BUNDLE, VERB FROM {SCHEMA}.VW_AGENT_VERB_COVERAGE
            WHERE NOT WAS_CALLED ORDER BY BUNDLE, VERB
        """)
        if never is None:
            failed += 1
        elif never:
            by_bundle: dict[str, list[str]] = {}
            for r in never:
                by_bundle.setdefault(str(r.get("BUNDLE")), []).append(str(r.get("VERB")))
            print("\n  never called:")
            for b, verbs in sorted(by_bundle.items()):
                print(f"    {b}: {', '.join(verbs)}")
            # A testing gap, not a defect - so it is reported but does NOT count
            # as a finding on its own. A demo deployment legitimately exercises a
            # fraction of the surface.
            print("\n  (a testing gap, not necessarily a bug - but an unexercised verb is")
            print("   exactly where a runtime fault hides, as deep_link showed)")

    # ---- 4. governed-path bypass -----------------------------------------
    # The metric the in-band run_sql nudge is judged against. Prose guidance for
    # this already exists in two places, so the only meaningful evidence is a
    # before/after number.
    h("4. Governed-path bypass (run_sql against semantic-view-modelled objects)")
    rows = run_sql(conn, f"""
        WITH total AS (
          SELECT COUNT(*) AS N FROM {SCHEMA}.VW_AGENT_VERB_CALLS
          WHERE LOWER(VERB) = 'run_sql'
        ), bypass AS (
          SELECT COUNT(DISTINCT ATTEMPT_ID) AS N FROM {SCHEMA}.VW_AGENT_GOVERNED_BYPASS
        )
        SELECT t.N AS RUN_SQL_CALLS, b.N AS BYPASS_CALLS,
               ROUND(DIV0(b.N, t.N) * 100, 1) AS BYPASS_PCT
        FROM total t, bypass b
    """)
    if rows is None:
        failed += 1
    else:
        table(rows, ["RUN_SQL_CALLS", "BYPASS_CALLS", "BYPASS_PCT"])
        if rows and int(rows[0].get("BYPASS_CALLS") or 0) > 0:
            findings += 1
            detail = run_sql(conn, f"""
                SELECT SEMANTIC_VIEW, GOVERNED_OBJECT, COUNT(*) AS CALLS
                FROM {SCHEMA}.VW_AGENT_GOVERNED_BYPASS
                GROUP BY SEMANTIC_VIEW, GOVERNED_OBJECT
                ORDER BY CALLS DESC LIMIT 12
            """)
            if detail is None:
                failed += 1
            else:
                print()
                table(detail, ["SEMANTIC_VIEW", "GOVERNED_OBJECT", "CALLS"])

    # ---- 5. turns --------------------------------------------------------
    # ALWAYS split by interface. Measured values: 'eval' (evaluation runs),
    # 'agent_admin_ui' (Snowsight), 'external' (SA app and REST), 'sql_function'.
    # Evaluation traffic dominates - 404 of 451 turns on the reference account -
    # so a blended average reports the cost and latency of the test harness rather
    # than of real use. ACCOUNT_USAGE lags up to ~3h, so a just-finished turn is
    # legitimately absent here.
    h(f"5. Turns, last {args.days} days (by interface)")
    rows = run_sql(conn, f"""
        SELECT COALESCE(INTERACTION_INTERFACE, 'unknown') AS INTERFACE,
               COUNT(*) AS TURNS,
               ROUND(AVG(TOTAL_MS) / 1000, 1) AS AVG_S,
               ROUND(MAX(TOTAL_MS) / 1000, 1) AS MAX_S,
               ROUND(SUM(TOKEN_CREDITS), 4) AS CREDITS,
               COUNT_IF(HAS_APP_DETAIL) AS WITH_QUESTION
        FROM {SCHEMA}.VW_AGENT_TURNS
        WHERE STARTED_AT > DATEADD(day, -{args.days}, CURRENT_TIMESTAMP())
        GROUP BY 1 ORDER BY TURNS DESC
    """)
    if rows is None:
        failed += 1
    else:
        table(rows, ["INTERFACE", "TURNS", "AVG_S", "MAX_S", "CREDITS", "WITH_QUESTION"])

    # WITH_QUESTION is the measured join rate between the app-side AGENT_TURN row
    # and the platform history. It is reported rather than assumed: the request-id
    # header is not a documented contract, so this number is the evidence that the
    # correlation works at all. A 0 here on a window containing app traffic means
    # the header did not round-trip and the join needs the time-window fallback.
    h("6. App-turn correlation (is the request id joining?)")
    rows = run_sql(conn, f"""
        SELECT
            (SELECT COUNT(*) FROM {SCHEMA}.AGENT_TURN) AS APP_ROWS,
            (SELECT COUNT(*) FROM {SCHEMA}.AGENT_TURN WHERE REQUEST_ID IS NOT NULL) AS WITH_REQUEST_ID,
            (SELECT COUNT(*) FROM {SCHEMA}.VW_AGENT_TURNS WHERE HAS_APP_DETAIL) AS JOINED
    """)
    if rows is None:
        failed += 1
    else:
        table(rows, ["APP_ROWS", "WITH_REQUEST_ID", "JOINED"])
        if rows:
            app_rows = int(rows[0].get("APP_ROWS") or 0)
            joined = int(rows[0].get("JOINED") or 0)
            if app_rows == 0:
                print("  no app turns recorded yet - deploy the SA app image, then ask the")
                print("  agent something through the app and re-run")
            elif joined == 0:
                print("  app turns exist but NONE joined the platform history. The request-id")
                print("  header did not round-trip; use the actor + time-window fallback.")
                findings += 1

    print("\n" + "=" * 72)
    if failed:
        print(f"INCOMPLETE: {failed} query/queries failed - report is not trustworthy")
        return 1
    if findings:
        print(f"{findings} finding(s) to look at")
        return 2
    print("no findings")
    return 0


if __name__ == "__main__":
    sys.exit(main())

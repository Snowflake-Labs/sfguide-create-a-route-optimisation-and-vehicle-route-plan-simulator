#!/usr/bin/env python3
"""check_agent_eval_thresholds.py - CI quality gate for Cortex Agent evaluations.

Reads GET_AI_EVALUATION_DATA for the newest run per agent and compares the MEAN
EVAL_AGG_SCORE per metric against per-metric thresholds. Exits non-zero on breach.

WHY THE MEAN AND NOT EACH RECORD
Thresholds are per-metric baselines taken from an agent's average score, which is
also what Snowsight charts. Comparing them against individual records fails a
healthy deployment: on run baseline-20260901-0930 FLEET_SUPER_AGENT averaged 0.778
tool_selection_accuracy (well above the 0.40 gate) while single records legitimately
scored 0.20 - a compound question answered with two calls to the same tool, and a
confirm-before-acting case that deterministic TSA cannot express. Per-record
checking reported 13 breaches on an agent that passes every metric.

Thresholds are advisory baselines, not aspirational targets: the guide
recommends setting them from observed baselines, not from target scores.
Adjust them once you have a few runs to establish the normal range.

Usage:
    python3 scripts/check_agent_eval_thresholds.py -c <connection>
    python3 scripts/check_agent_eval_thresholds.py -c <connection> --run baseline-20260901-0930
"""
import argparse
import json
import subprocess
import sys

EVAL_DB = "FLEET_INTELLIGENCE"
EVAL_SCHEMA = "EVALS"
AGENT_SCHEMA = "SYNAPSE_USER"

# Per-metric thresholds. Set from observed baselines, not aspirational targets.
# Scores below these trigger a non-zero exit (CI gate failure).
THRESHOLDS = {
    "answer_correctness": 0.50,
    "logical_consistency": 0.50,
    "tool_selection_accuracy": 0.40,
    "tool_execution_accuracy": 0.40,
}

AGENTS = [
    "FLEET_AGENT",
    "FLEET_OPS_AGENT",
    "FLEET_ADMIN_AGENT",
    "FLEET_SUPER_AGENT",
]

TRACK = '{"origin":"sf_sit-is-fleet","name":"oss-install-fleet-apps","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql","component":"eval-threshold-gate"}}'


def run_sql(connection: str, sql: str) -> list:
    tag_sql = f"ALTER SESSION SET query_tag = '{TRACK}';"
    result = subprocess.run(
        ["snow", "sql", "-c", connection, "--format", "json",
         "-q", f"{tag_sql} {sql}", "--enable-templating", "NONE"],
        capture_output=True, text=True
    )
    if result.returncode != 0:
        print(f"SQL error: {result.stderr}", file=sys.stderr)
        return []
    try:
        data = json.loads(result.stdout)
        # TAG_SQL prepends a statement -> multiple result sets [[{status}],[...]]
        return data[-1] if data and isinstance(data[0], list) else data
    except json.JSONDecodeError:
        return []


def latest_run(connection: str, agent: str) -> str | None:
    """Newest evaluation run name for an agent, or None if it has never been run.

    GET_AI_EVALUATION_DATA requires a run_name, so the run has to be discovered
    first. GET_AI_OBSERVABILITY_LOGS carries it in
    record_attributes:"snow.ai.observability.run.name", which is one of the two
    fields the docs guarantee to be present.
    """
    rows = run_sql(connection, f"""
        SELECT record_attributes:"snow.ai.observability.run.name"::string AS RUN_NAME
        FROM TABLE(SNOWFLAKE.LOCAL.GET_AI_OBSERVABILITY_LOGS(
            '{EVAL_DB}', '{AGENT_SCHEMA}', '{agent}', 'CORTEX AGENT'
        ))
        WHERE record_attributes:"snow.ai.observability.run.name" IS NOT NULL
        GROUP BY 1
        ORDER BY MAX(timestamp) DESC
        LIMIT 1
    """)
    if not rows:
        return None
    row = rows[0]
    return row.get("RUN_NAME", row.get("run_name"))


def check_agent(connection: str, agent: str, run_name: str | None) -> list[str]:
    """Returns a list of breach messages, empty if all OK."""
    if not run_name:
        run_name = latest_run(connection, agent)
        if not run_name:
            # An agent that has never been evaluated is a GATE FAILURE, not a skip.
            # This used to print "skipping" and then the gate reported PASSED with
            # nothing checked at all - a vacuous gate.
            return [f"  {agent}: no evaluation run found - nothing to gate on"]
        print(f"  {agent}: latest run = {run_name}")

    rows = run_sql(connection, f"""
        SELECT * FROM TABLE(SNOWFLAKE.LOCAL.GET_AI_EVALUATION_DATA(
            '{EVAL_DB}', '{AGENT_SCHEMA}', '{agent}', 'CORTEX AGENT', '{run_name}'
        ))
    """)

    # Aggregate to one mean per metric BEFORE comparing - see the module docstring.
    sums: dict[str, float] = {}
    counts: dict[str, int] = {}
    mins: dict[str, float] = {}
    for row in rows:
        metric = row.get("METRIC_NAME", row.get("metric_name", ""))
        score = row.get("EVAL_AGG_SCORE", row.get("eval_agg_score"))
        if score is None or metric not in THRESHOLDS:
            continue
        score = float(score)
        sums[metric] = sums.get(metric, 0.0) + score
        counts[metric] = counts.get(metric, 0) + 1
        mins[metric] = score if metric not in mins else min(mins[metric], score)

    if not counts:
        metrics_found = sorted({r.get("METRIC_NAME", r.get("metric_name", "")) for r in rows})
        return [f"  {agent}: no threshold-able metrics in run '{run_name}' (found: {metrics_found})"]

    breaches = []
    for metric in sorted(counts):
        mean = sums[metric] / counts[metric]
        threshold = THRESHOLDS[metric]
        status = "OK" if mean >= threshold else "BREACH"
        line = (f"  {agent}.{metric}: mean {mean:.3f} over {counts[metric]} record(s), "
                f"min {mins[metric]:.2f} (threshold {threshold:.2f}) [{status}]")
        print(line)
        if mean < threshold:
            breaches.append(line)

    return breaches


def main():
    parser = argparse.ArgumentParser(description="CI gate for agent eval thresholds")
    parser.add_argument("-c", "--connection", required=True, help="Snowflake connection name")
    parser.add_argument("--run", default=None, help="Evaluation run name to check")
    parser.add_argument("--agents", default=None, help="Comma-separated agent names to check")
    args = parser.parse_args()

    agents = args.agents.split(",") if args.agents else AGENTS
    all_breaches = []

    print(f"[eval-gate] checking thresholds (run={args.run or 'latest'})...")
    for agent in agents:
        breaches = check_agent(args.connection, agent.strip(), args.run)
        all_breaches.extend(breaches)

    if all_breaches:
        print(f"\n[eval-gate] FAILED: {len(all_breaches)} threshold breach(es)")
        sys.exit(1)
    else:
        print("\n[eval-gate] PASSED: all scores above thresholds")
        sys.exit(0)


if __name__ == "__main__":
    main()

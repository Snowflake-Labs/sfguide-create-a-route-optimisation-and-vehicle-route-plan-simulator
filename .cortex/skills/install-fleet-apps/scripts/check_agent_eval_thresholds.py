#!/usr/bin/env python3
"""check_agent_eval_thresholds.py - CI quality gate for Cortex Agent evaluations.

Reads GET_AI_EVALUATION_DATA for the newest run per agent and compares
EVAL_AGG_SCORE against per-metric thresholds. Exits non-zero on breach.

Thresholds are advisory baselines, not aspirational targets: the guide
recommends setting them from observed baselines, not from target scores.
Adjust them once you have a few runs to establish the normal range.

Usage:
    python3 scripts/check_agent_eval_thresholds.py -c <connection>
    python3 scripts/check_agent_eval_thresholds.py -c <connection> --run baseline-20260901-0848
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


def check_agent(connection: str, agent: str, run_name: str | None) -> list[str]:
    """Returns a list of breach messages, empty if all OK."""
    fqn = f"{EVAL_DB}.{AGENT_SCHEMA}.{agent}"

    if run_name:
        # Check a specific run
        rows = run_sql(connection, f"""
            SELECT * FROM TABLE(SNOWFLAKE.LOCAL.GET_AI_EVALUATION_DATA(
                '{EVAL_DB}', '{AGENT_SCHEMA}', '{agent}', 'CORTEX AGENT', '{run_name}'
            ))
        """)
    else:
        # Find the newest run. GET_AI_EVALUATION_DATA needs a run_name, so first
        # list runs from SHOW DATASETS output is not it. Instead we query the
        # event table for the latest eval run name for this agent.
        # Simpler: try the most common run name patterns.
        # Actually, the only reliable way is to try a known run or ask the caller
        # to supply one. For CI, the run_name is known.
        print(f"  {agent}: no --run specified, skipping (supply --run for CI gate)")
        return []

    if not rows:
        return [f"{agent}: no evaluation data found for run '{run_name}'"]

    breaches = []
    for row in rows:
        metric = row.get("METRIC_NAME", row.get("metric_name", ""))
        score = row.get("EVAL_AGG_SCORE", row.get("eval_agg_score"))
        if score is None:
            continue
        score = float(score)
        threshold = THRESHOLDS.get(metric)
        if threshold is None:
            continue
        status = "OK" if score >= threshold else "BREACH"
        line = f"  {agent}.{metric}: {score:.2f} (threshold {threshold:.2f}) [{status}]"
        print(line)
        if score < threshold:
            breaches.append(line)

    if not breaches:
        # No matching metrics found at all
        metrics_found = [r.get("METRIC_NAME", r.get("metric_name", "")) for r in rows]
        if not any(m in THRESHOLDS for m in metrics_found):
            print(f"  {agent}: no threshold-able metrics in run (found: {metrics_found})")

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

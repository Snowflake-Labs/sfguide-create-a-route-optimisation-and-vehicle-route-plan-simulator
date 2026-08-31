#!/usr/bin/env python3
"""Agent behavioral eval runner.

Runs the deployed Cortex Agent (FLEET_AGENT) on real prompts, then grades typed
assertions against the audit trail, ground-truth data, and an LLM judge. This is
kept separate from run_evals.py because it requires a live deployed stack and
must not block the static skill gate.

Usage:
    export FLEET_EVAL_PAT=<programmatic access token>
    python3 run_agent_evals.py [--case ID] [--fast] [--judge-model NAME]
                               [--connection NAME] [--out-dir DIR]
                               [--clean] [--no-show-io]

    --fast runs a deterministic smoke: verb + sql assertions only, skipping the
    LLM judge. Ideal for a routine post-deploy check (see AGENTS.md).

Prerequisites:
    - Deployed FLEET_AGENT + ROUTING_MCP and the target region's ORS services
      RUNNING (suspended ORS makes routing verbs return embedded errors).
    - FLEET_EVAL_PAT exported. Account URL from SNOWFLAKE_ACCOUNT_URL or the
      active snow connection.

Exit codes: 0 all assertions passed, 1 one or more failed, 2 setup/runtime issue.
"""

import argparse
import json
import shutil
import sys
from pathlib import Path

import yaml

from lib import agent_client, agent_eval, sf

EVALS_DIR = Path(__file__).parent
DEFAULT_CASES = EVALS_DIR / "test-cases" / "agent-cases.yaml"
DEFAULT_OUT = EVALS_DIR / "results" / "agent" / "latest"


def log(msg: str) -> None:
    print(msg, flush=True)


def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(description="Run agent behavioral evals.")
    p.add_argument("--cases-file", default=str(DEFAULT_CASES), help="Path to agent-cases.yaml.")
    p.add_argument("--case", default="", help="Run only one case by id.")
    p.add_argument("--judge-model", default="", help="Override judge model for judge assertions.")
    p.add_argument("--connection", default="", help="snow connection name (default: active).")
    p.add_argument("--out-dir", default=str(DEFAULT_OUT), help="Output directory.")
    p.add_argument("--clean", action="store_true", help="Delete output dir before run.")
    p.add_argument("--show-io", dest="show_io", action="store_true", help="Print per-turn IO trace (default).")
    p.add_argument("--no-show-io", dest="show_io", action="store_false", help="Disable IO trace.")
    p.set_defaults(show_io=True)
    p.add_argument("--fast", action="store_true",
                   help="Deterministic smoke mode: skip judge (CORTEX.COMPLETE) assertions.")
    p.add_argument("--skip-ors-check", action="store_true", help="Skip the ORS RUNNING pre-flight.")
    return p.parse_args()


def load_cases(path: Path) -> dict:
    data = yaml.safe_load(path.read_text(encoding="utf-8"))
    if not data or "cases" not in data or not data["cases"]:
        raise ValueError("agent-cases.yaml must contain a non-empty 'cases' list.")
    return data


def preflight_ors(connection: str | None) -> None:
    """Fail fast if any ORS service is not RUNNING."""
    rows = sf.query("SHOW SERVICES IN DATABASE OPENROUTESERVICE_APP", connection=connection)
    if not rows:
        raise agent_client.AgentError(
            "No services found in OPENROUTESERVICE_APP. Is the routing engine deployed?"
        )
    not_running = []
    for r in rows:
        status = str(r.get("status") or r.get("STATUS") or "").upper()
        name = r.get("name") or r.get("NAME") or "?"
        if status and status != "RUNNING":
            not_running.append(f"{name}={status}")
    if not_running:
        raise agent_client.AgentError(
            "ORS services not RUNNING: " + ", ".join(not_running)
            + ". Resume the region before running agent evals."
        )


def trace_turn(turn: dict, io_max: int = 500) -> None:
    for call in turn.get("tool_calls", []):
        log(f"    [tool_use:{call['name']}] {json.dumps(call.get('input', {}))[:io_max]}")
    text = turn.get("text", "")
    if text:
        log(f"    [assistant:text] {text[:io_max]}")
    for err in turn.get("errors", []):
        log(f"    [error] {err[:io_max]}")


def main() -> int:
    args = parse_args()
    connection = args.connection or None
    cases_path = Path(args.cases_file).resolve()
    out_dir = Path(args.out_dir).resolve()

    log("[1/5] Checking prerequisites...")
    if not shutil.which("snow"):
        print("snow CLI not found on PATH.", file=sys.stderr)
        return 2
    try:
        pat = agent_client.get_pat()
        account_url = agent_client.resolve_account_url(connection)
    except agent_client.AgentError as exc:
        print(str(exc), file=sys.stderr)
        return 2
    log(f"  -> Account URL: {account_url}")

    log("[2/5] Loading cases...")
    try:
        config = load_cases(cases_path)
    except (ValueError, OSError, yaml.YAMLError) as exc:
        print(f"Failed to load cases: {exc}", file=sys.stderr)
        return 2
    cases = config["cases"]
    if args.case:
        cases = [c for c in cases if c.get("id") == args.case]
        if not cases:
            print(f"Case not found: {args.case}", file=sys.stderr)
            return 2

    agent_db = config.get("agent_database", agent_client.DEFAULT_AGENT_DB)
    agent_schema = config.get("agent_schema", agent_client.DEFAULT_AGENT_SCHEMA)
    agent_name = config.get("agent_name", agent_client.DEFAULT_AGENT_NAME)
    verb_attempt = config.get("verb_attempt_table", "OPENROUTESERVICE_APP.ROUTING.VERB_ATTEMPT")
    judge_model = args.judge_model or config.get("judge_model", agent_eval.DEFAULT_JUDGE_MODEL)
    mode = "fast (verb+sql only)" if args.fast else "full (verb+sql+judge)"
    log(f"  -> Agent: {agent_db}.{agent_schema}.{agent_name}; mode: {mode}; "
        f"judge: {judge_model}; cases: {len(cases)}")

    if not args.skip_ors_check:
        log("  -> ORS pre-flight (SHOW SERVICES)...")
        try:
            preflight_ors(connection)
        except (agent_client.AgentError, sf.SqlError) as exc:
            print(str(exc), file=sys.stderr)
            return 2

    log("[3/5] Preparing output directory...")
    if args.clean and out_dir.exists():
        shutil.rmtree(out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)

    log("[4/5] Running cases...")
    case_summaries = []
    tokens_per_turn = []
    durations_ms = []

    for case in cases:
        case_id = case["id"]
        case_dir = out_dir / case_id
        if case_dir.exists():
            shutil.rmtree(case_dir)
        case_dir.mkdir(parents=True, exist_ok=True)
        log(f"- Case: {case_id}")

        # Snowflake-side start timestamp bounds the audit window (avoids clock skew).
        start_ts = sf.scalar("SELECT TO_VARCHAR(CURRENT_TIMESTAMP(), 'YYYY-MM-DD HH24:MI:SS.FF3 TZH:TZM')",
                             connection=connection)

        try:
            turn = agent_client.run_agent(
                case["prompt"], account_url, pat, agent_db, agent_schema, agent_name,
            )
        except agent_client.AgentError as exc:
            print(f"  -> Agent invocation failed: {exc}", file=sys.stderr)
            return 2

        if args.show_io:
            trace_turn(turn)

        subs = {"verb_attempt": verb_attempt, "start_ts": start_ts}
        grading = agent_eval.grade_case(turn, case, subs, judge_model, connection,
                                        skip_judge=args.fast)

        # Artifacts
        (case_dir / "prompt.txt").write_text(case["prompt"] + "\n", encoding="utf-8")
        (case_dir / "response.md").write_text((turn.get("text") or "") + "\n", encoding="utf-8")
        (case_dir / "tool-calls.json").write_text(
            json.dumps(turn.get("tool_calls", []), indent=2), encoding="utf-8")
        (case_dir / "events.ndjson").write_text(
            "\n".join(json.dumps(e, ensure_ascii=True) for e in turn.get("events", [])) + "\n",
            encoding="utf-8")
        (case_dir / "grading.json").write_text(json.dumps(grading, indent=2), encoding="utf-8")

        s = grading["summary"]
        log(f"  -> Assertions: {s['passed']}/{s['total']} passed (pass_rate={s['pass_rate']:.2f})")
        case_summaries.append({"id": case_id, **s})

        usage = turn.get("usage")
        if isinstance(usage, dict):
            tokens_per_turn.append((usage.get("input_tokens") or 0) + (usage.get("output_tokens") or 0))
        if isinstance(turn.get("duration_ms"), int):
            durations_ms.append(turn["duration_ms"])

    total_passed = sum(c["passed"] for c in case_summaries)
    total_assertions = sum(c["total"] for c in case_summaries)
    summary = {
        "agent_fqn": f"{agent_db}.{agent_schema}.{agent_name}",
        "run_config": {"judge_model": judge_model, "account_url": account_url,
                       "fast": args.fast},
        "cases": case_summaries,
        "summary": {
            "passed": total_passed,
            "total": total_assertions,
            "pass_rate": (total_passed / total_assertions) if total_assertions else 0.0,
            "avg_tokens": (sum(tokens_per_turn) / len(tokens_per_turn)) if tokens_per_turn else None,
            "avg_duration_ms": (sum(durations_ms) / len(durations_ms)) if durations_ms else None,
        },
    }
    (out_dir / "summary.json").write_text(json.dumps(summary, indent=2), encoding="utf-8")

    log("[5/5] Summary:")
    print(json.dumps(summary["summary"], indent=2), flush=True)
    if total_assertions and total_passed == total_assertions:
        log("Result: PASS (all assertions passed)")
        return 0
    log("Result: FAIL (some assertions failed)")
    return 1


if __name__ == "__main__":
    raise SystemExit(main())

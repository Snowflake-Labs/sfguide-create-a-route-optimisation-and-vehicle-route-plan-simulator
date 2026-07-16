"""Behavioral eval orchestration and typed assertion evaluators.

Grades a completed agent turn against three assertion types:

  verb  - a VERB_ATTEMPT audit row exists for the expected verb with outcome
          'ok' since the turn started. Proves the synapse envelope path
          (auditability) and, for ORS-backed verbs, that the engine was called
          live rather than read from a precomputed table.
  sql   - a caller-supplied SELECT ... AS OK returns a single truthy row.
          Ground-truth checks: not empty, row count, tolerance, no error.
  judge - SNOWFLAKE.CORTEX.COMPLETE grades a natural-language claim over the
          captured transcript and returns strict JSON {passed, evidence}.

All SQL is read-only.
"""

import json

from . import sf

DEFAULT_JUDGE_MODEL = "claude-3-5-sonnet"


def _apply_subs(text: str, subs: dict) -> str:
    """Replace {{key}} tokens in text with values from subs."""
    out = text
    for key, value in subs.items():
        out = out.replace("{{" + key + "}}", str(value))
    return out


def eval_verb(assertion: dict, subs: dict, connection: str | None) -> dict:
    """Assert a VERB_ATTEMPT row exists for one of the expected verbs."""
    verbs = assertion.get("verbs") or []
    if not verbs:
        return {"passed": False, "evidence": "No verbs listed in assertion."}
    verb_list = ", ".join("'" + v.replace("'", "''") + "'" for v in verbs)
    table = subs["verb_attempt"]
    start_ts = subs["start_ts"]
    outcome = assertion.get("outcome", "ok")
    sql = (
        f"SELECT COUNT(*) AS N, MAX(VERB) AS SAMPLE_VERB FROM {table} "
        f"WHERE VERB IN ({verb_list}) AND OUTCOME = '{outcome}' "
        f"AND ACTOR = CURRENT_USER() AND AT >= '{start_ts}'"
    )
    rows = sf.query(sql, connection=connection)
    n = int(rows[0].get("N", 0)) if rows else 0
    passed = n > 0
    evidence = (
        f"{n} '{outcome}' audit row(s) for verb in {verbs} since {start_ts}."
        if passed
        else f"No '{outcome}' audit row for any of {verbs} since {start_ts}."
    )
    return {"passed": passed, "evidence": evidence, "commands_run": [sql]}


def eval_sql(assertion: dict, subs: dict, connection: str | None) -> dict:
    """Run a caller-supplied SELECT that must yield a single OK column = TRUE."""
    text = assertion.get("text")
    if not text:
        return {"passed": False, "evidence": "No SQL text in assertion."}
    sql = _apply_subs(text, subs)
    rows = sf.query(sql, connection=connection)
    if not rows:
        return {"passed": False, "evidence": "Query returned no rows.", "commands_run": [sql]}
    first = rows[0]
    ok_val = first.get("OK", first.get("ok"))
    if ok_val is None and len(first) == 1:
        ok_val = next(iter(first.values()))
    passed = str(ok_val).strip().lower() in ("true", "1", "t", "yes")
    return {
        "passed": passed,
        "evidence": f"OK={ok_val}; row={json.dumps(first, default=str)[:200]}",
        "commands_run": [sql],
    }


def eval_judge(assertion: dict, turn: dict, judge_model: str,
               connection: str | None) -> dict:
    """Grade a natural-language claim with CORTEX.COMPLETE over the transcript."""
    claim = assertion.get("text")
    if not claim:
        return {"passed": False, "evidence": "No claim text in assertion."}
    transcript = {
        "assistant_text": turn.get("text", ""),
        "tool_calls": turn.get("tool_calls", []),
        "errors": turn.get("errors", []),
    }
    grading_prompt = (
        "You grade one assertion about an AI assistant's turn. "
        "Use ONLY the transcript below. Respond with STRICT JSON and nothing "
        'else: {"passed": true|false, "evidence": "<one sentence>"}.\n\n'
        f"Assertion: {claim}\n\n"
        f"Transcript JSON:\n{json.dumps(transcript, default=str)}"
    )
    safe_prompt = sf.escape_dollar(grading_prompt)
    safe_model = judge_model.replace("'", "''")
    sql = (
        f"SELECT SNOWFLAKE.CORTEX.COMPLETE('{safe_model}', $${safe_prompt}$$) AS OUT"
    )
    rows = sf.query(sql, connection=connection)
    raw = rows[0].get("OUT", "") if rows else ""
    verdict = _parse_judge_json(raw)
    return {
        "passed": bool(verdict.get("passed", False)),
        "evidence": str(verdict.get("evidence", "No evidence returned.")),
        "commands_run": [f"CORTEX.COMPLETE({judge_model}, <grading prompt>)"],
    }


def _parse_judge_json(raw: str) -> dict:
    """Extract the {passed, evidence} object from a model completion."""
    text = (raw or "").strip()
    if not text:
        return {"passed": False, "evidence": "Empty judge response."}
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        start = text.find("{")
        end = text.rfind("}")
        if start >= 0 and end > start:
            try:
                return json.loads(text[start:end + 1])
            except json.JSONDecodeError:
                pass
    return {"passed": False, "evidence": f"Unparseable judge response: {text[:160]}"}


def grade_case(turn: dict, case: dict, subs: dict, judge_model: str,
               connection: str | None, skip_judge: bool = False) -> dict:
    """Evaluate every assertion in a case and return a grading summary.

    When skip_judge is set, judge assertions are omitted entirely (not counted
    toward the total) so a fast post-deploy smoke run stays deterministic and
    avoids CORTEX.COMPLETE latency/credits.
    """
    results = []
    skipped = 0
    for assertion in case.get("assertions", []):
        a_type = assertion.get("type")
        if skip_judge and a_type == "judge":
            skipped += 1
            continue
        try:
            if a_type == "verb":
                res = eval_verb(assertion, subs, connection)
            elif a_type == "sql":
                res = eval_sql(assertion, subs, connection)
            elif a_type == "judge":
                res = eval_judge(assertion, turn, judge_model, connection)
            else:
                res = {"passed": False, "evidence": f"Unknown assertion type '{a_type}'."}
        except Exception as exc:  # keep grading the rest of the suite
            res = {"passed": False, "evidence": f"Assertion raised: {exc}"}
        label = assertion.get("description") or assertion.get("text") or a_type
        results.append({"type": a_type, "assertion": label, **res})

    passed = sum(1 for r in results if r["passed"])
    total = len(results)
    return {
        "assertion_results": results,
        "summary": {
            "passed": passed,
            "failed": total - passed,
            "total": total,
            "skipped": skipped,
            "pass_rate": (passed / total) if total else 0.0,
        },
    }

"""Read-only Snowflake helper for the agent behavioral evals.

Runs SELECT / SHOW / DESCRIBE through the `snow` CLI and returns parsed rows.
Every session sets the mandatory query_tag. This module never issues DDL/DML and
never creates Snowflake objects, so no object COMMENT tags are required.
"""

import json
import subprocess

QUERY_TAG = (
    '{"origin":"sf_sit-is-fleet","name":"oss-agent-evals",'
    '"version":{"major":1,"minor":0},'
    '"attributes":{"is_quickstart":1,"source":"sql"}}'
)


class SqlError(RuntimeError):
    """Raised when a snow CLI query fails."""


def _extract_last_json(stdout: str):
    """Return the last top-level JSON value in stdout.

    `snow sql` with multiple statements (the query_tag ALTER plus the real
    query) can emit more than one JSON document. The query result we care about
    is always the last one.
    """
    text = stdout.strip()
    if not text:
        return []
    # Fast path: the whole output is one JSON document.
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        pass
    # Slow path: scan for balanced top-level JSON arrays/objects, keep the last.
    decoder = json.JSONDecoder()
    idx = 0
    last = None
    n = len(text)
    while idx < n:
        ch = text[idx]
        if ch in "[{":
            try:
                value, end = decoder.raw_decode(text, idx)
                last = value
                idx = end
                continue
            except json.JSONDecodeError:
                pass
        idx += 1
    return last if last is not None else []


def query(sql: str, connection: str | None = None, timeout: int = 180) -> list[dict]:
    """Run a read-only query and return rows as a list of dicts.

    The query_tag ALTER is prepended so the eval session is always attributed.
    """
    combined = f"ALTER SESSION SET query_tag='{QUERY_TAG}';\n{sql}"
    cmd = ["snow", "sql", "-q", combined, "--format", "json"]
    if connection:
        cmd += ["-c", connection]
    proc = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout)
    if proc.returncode != 0:
        raise SqlError(proc.stderr.strip() or proc.stdout.strip() or "snow sql failed")
    result = _extract_last_json(proc.stdout)
    return _rows_from(result)


def _rows_from(result) -> list[dict]:
    """Normalize a parsed snow-CLI JSON result to a flat list of row dicts.

    `snow sql -q` runs the query_tag ALTER plus the real query as a multi-
    statement batch and emits one JSON array per statement, nested:
        [[{"status": "..."}], [{"OK": true}]]
    In that case the rows we care about are the LAST statement's array. A
    single-statement result is a flat list of dicts (or one dict).
    """
    if isinstance(result, dict):
        return [result]
    if isinstance(result, list):
        if result and all(isinstance(x, list) for x in result):
            last = result[-1]
            return [r for r in last if isinstance(r, dict)]
        return [r for r in result if isinstance(r, dict)]
    return []


def scalar(sql: str, connection: str | None = None):
    """Run a query and return the first column of the first row (or None)."""
    rows = query(sql, connection=connection)
    if not rows:
        return None
    first = rows[0]
    for value in first.values():
        return value
    return None


def escape_dollar(text: str) -> str:
    """Neutralize any dollar-quote terminator so text is safe inside $$ ... $$."""
    return (text or "").replace("$$", "$ $")

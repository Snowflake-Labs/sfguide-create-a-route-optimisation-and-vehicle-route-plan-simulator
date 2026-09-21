"""REST client that invokes the deployed Cortex Agent over the streaming API.

Mirrors the request shape and SSE parsing the SA app uses
(fleet_sa_app/ui/src/lib/agent-config.ts and cortex-stream.ts) so an eval turn
exercises the exact same path a real user turn does. Uses agent-object mode:
POST {accountUrl}/api/v2/databases/{db}/schemas/{schema}/agents/{agent}:run

Auth is a Programmatic Access Token supplied via the FLEET_EVAL_PAT env var.
Standard library only (urllib) so the evals add no Python dependencies.
"""

import json
import os
import time
import urllib.error
import urllib.request

from . import sf


class AgentError(RuntimeError):
    """Raised for setup/transport failures (missing PAT, unreachable host)."""


DEFAULT_AGENT_DB = "FLEET_INTELLIGENCE"
DEFAULT_AGENT_SCHEMA = "SYNAPSE_USER"
DEFAULT_AGENT_NAME = "FLEET_AGENT"


def resolve_account_url(connection: str | None = None) -> str:
    """Return the https base URL for the account.

    Prefers SNOWFLAKE_ACCOUNT_URL; otherwise derives it from the given snow
    connection via CURRENT_ORGANIZATION_NAME / CURRENT_ACCOUNT_NAME.

    `connection` is REQUIRED to be threaded through by the caller. It used to be
    omitted here while every other query in the run received it, so the URL was
    built from whichever connection the CLI defaults to. Pointed at one account
    and run with --connection for another, that produced a URL for the DEFAULT
    account and the run died on an SSL hostname mismatch that reads like a
    certificate problem rather than a wiring one.
    """
    env_url = os.environ.get("SNOWFLAKE_ACCOUNT_URL")
    if env_url:
        return env_url.rstrip("/")
    rows = sf.query(
        "SELECT CURRENT_ORGANIZATION_NAME() AS ORG, CURRENT_ACCOUNT_NAME() AS ACCT",
        connection=connection,
    )
    if not rows:
        raise AgentError(
            "Could not resolve account URL. Set SNOWFLAKE_ACCOUNT_URL "
            "(e.g. https://ORG-ACCOUNT.snowflakecomputing.com)."
        )
    org = rows[0].get("ORG")
    acct = rows[0].get("ACCT")
    if not org or not acct:
        raise AgentError("Could not derive account URL from the active connection.")
    return f"https://{org}-{acct}.snowflakecomputing.com"


def get_pat() -> str:
    """Return the Programmatic Access Token from the environment."""
    pat = os.environ.get("FLEET_EVAL_PAT")
    if not pat:
        raise AgentError(
            "FLEET_EVAL_PAT is not set. Export a Programmatic Access Token with "
            "USAGE on the agent before running the agent evals."
        )
    return pat


def build_url(account_url: str, database: str, schema: str, agent: str) -> str:
    """Build the agent-object :run endpoint URL."""
    base = account_url.rstrip("/")
    return f"{base}/api/v2/databases/{database}/schemas/{schema}/agents/{agent}:run"


def _parse_sse_chunk(chunk: str):
    """Parse one SSE record into (event_type, data_dict) or None.

    Mirrors parseSSEChunk in cortex-stream.ts: an `event:` line plus one or more
    `data:` lines whose payloads are concatenated then JSON-parsed.
    """
    event_type = "message"
    data_str = ""
    for line in chunk.split("\n"):
        if line.startswith("event:"):
            event_type = line[6:].strip()
        elif line.startswith("data:"):
            data_str += line[5:].lstrip()
    if not data_str:
        return None
    try:
        return event_type, json.loads(data_str)
    except json.JSONDecodeError:
        return None


def _scan_usage(data: dict) -> dict | None:
    """Best-effort token usage extraction from an event payload."""
    for key in ("usage", "token_usage"):
        usage = data.get(key)
        if isinstance(usage, dict):
            it = usage.get("input_tokens") or usage.get("prompt_tokens")
            ot = usage.get("output_tokens") or usage.get("completion_tokens")
            if isinstance(it, int) or isinstance(ot, int):
                return {"input_tokens": it or 0, "output_tokens": ot or 0}
    meta = data.get("metadata")
    if isinstance(meta, dict):
        return _scan_usage(meta)
    return None


def run_agent(prompt: str, account_url: str, pat: str, database: str,
              schema: str, agent: str, timeout: int = 180) -> dict:
    """Send a single-turn prompt to the agent and collect the streamed result.

    Returns a dict with: text (final assistant text), tool_calls (ordered list of
    {name, input}), tool_results (list of {name, output}), errors, metadata,
    usage, duration_ms, and raw events (list of {event, data}).
    """
    url = build_url(account_url, database, schema, agent)
    body = json.dumps({
        "messages": [{"role": "user", "content": [{"type": "text", "text": prompt}]}],
        "stream": True,
    }).encode("utf-8")
    req = urllib.request.Request(url, data=body, method="POST")
    req.add_header("Content-Type", "application/json")
    req.add_header("Accept", "text/event-stream")
    req.add_header("Authorization", f"Bearer {pat}")
    req.add_header("X-Snowflake-Authorization-Token-Type", "PROGRAMMATIC_ACCESS_TOKEN")

    text_parts: list[str] = []
    tool_calls: list[dict] = []
    tool_results: list[dict] = []
    errors: list[str] = []
    metadata: dict = {}
    usage: dict | None = None
    events: list[dict] = []

    start = time.time()
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            buffer = ""
            while True:
                raw = resp.readline()
                if not raw:
                    break
                buffer += raw.decode("utf-8", errors="replace")
                # SSE records are separated by a blank line.
                while "\n\n" in buffer:
                    chunk, buffer = buffer.split("\n\n", 1)
                    parsed = _parse_sse_chunk(chunk)
                    if not parsed:
                        continue
                    event_type, data = parsed
                    events.append({"event": event_type, "data": data})
                    if usage is None:
                        usage = _scan_usage(data)
                    if event_type == "response.text.delta":
                        t = data.get("text")
                        if t:
                            text_parts.append(t)
                    elif event_type == "response.tool_use":
                        tool_calls.append({
                            "name": data.get("name") or data.get("type") or "unknown",
                            "input": data.get("input") or {},
                        })
                    elif event_type == "response.tool_result":
                        tool_results.append({
                            "name": data.get("name") or data.get("type") or "unknown",
                            "content": data.get("content"),
                        })
                    elif event_type == "metadata":
                        meta = data.get("metadata")
                        if isinstance(meta, dict):
                            metadata = meta
                    elif event_type == "error":
                        errors.append(str(data.get("message") or "Unknown error"))
    except urllib.error.HTTPError as exc:
        detail = exc.read().decode("utf-8", errors="replace") if exc.fp else ""
        raise AgentError(f"Agent API error {exc.code}: {detail[:500]}") from exc
    except urllib.error.URLError as exc:
        raise AgentError(f"Agent API unreachable: {exc.reason}") from exc

    return {
        "text": "".join(text_parts).strip(),
        "tool_calls": tool_calls,
        "tool_results": tool_results,
        "errors": errors,
        "metadata": metadata,
        "usage": usage,
        "duration_ms": int((time.time() - start) * 1000),
        "events": events,
    }

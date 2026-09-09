#!/usr/bin/env python3
"""Drop agent tools whose backing object does not exist in this account.

WHY THIS EXISTS
---------------
Snowflake validates EVERY tool target when an agent request is served, not when the
agent is created. One tool pointing at a missing object therefore fails the WHOLE
request, whatever was asked. On a fresh agnostic install the consumer agent shipped
a `query_offers` tool bound to FLEET_INTELLIGENCE.SEMANTIC.SV_OFFERS, which install
step 4.5 deliberately SKIPS because it needs the MARKETPLACE schema - explicitly
out of scope for the agnostic installer. Result: every FLEET_AGENT question, even a
pure routing one with no analytics involved, came back as

    Agent API error 400: SQL compilation error:
    Semantic View 'FLEET_INTELLIGENCE.SEMANTIC.SV_OFFERS' does not exist or not authorized.

so the agent was 100% broken on a clean install while every object-level check
passed. Nothing in the install verifies the agent can answer anything, which is why
this went unnoticed.

Pruning at CREATE time rather than deleting the tool from the spec keeps the specs
declarative: the freight-exchange skill can add SV_OFFERS later, and re-running
create_agents.sh then picks the tool back up. That also covers the general class -
any optional semantic view or search service - instead of this one instance.

MCP SERVERS ARE THE SAME FAILURE CLASS
--------------------------------------
An `mcp_servers[].server_spec.name` pointing at a server that does not exist fails
the whole request for exactly the same reason, so it is probed here too. This is not
hypothetical: `npx synapse deploy` does CREATE OR REPLACE MCP SERVER, and
create_agents.sh must be re-run after every bundle deploy, so a renamed, relocated,
or not-yet-installed bundle leaves a dangling reference in an otherwise valid spec.

Dropping an MCP server is more consequential than dropping one analytics tool - the
agent keeps its Cortex Analyst tools and can still answer analytics questions, but
it silently loses every verb on that server (all 21 routing verbs, in the case of
ROUTING_MCP). That is still strictly better than failing 100% of requests, but it is
reported as a WARN rather than an informational line so it cannot pass unnoticed.

Usage:
    python3 prune_agent_specs.py --connection <conn> --out-dir <dir> spec.json ...

Writes a pruned copy of each spec into out-dir under the same basename and prints
what it removed. Exit 0 on success (including "nothing to prune"), 2 if the
account could not be inspected - in which case the caller should use the specs
unchanged rather than deploying a silently emptied agent.
"""
from __future__ import annotations

import argparse
import json
import pathlib
import subprocess
import sys


def snow_json(connection: str, sql: str):
    """Run one statement and return parsed rows, or None on failure."""
    cmd = ["snow", "sql", "-c", connection, "--format", "json", "-q", sql]
    try:
        r = subprocess.run(cmd, capture_output=True, text=True, timeout=180)
    except (OSError, subprocess.SubprocessError):
        return None
    if r.returncode != 0:
        return None
    try:
        return json.loads(r.stdout)
    except json.JSONDecodeError:
        return None


def fqns(rows, *, db="database_name", schema="schema_name", name="name") -> set:
    out = set()
    for row in rows or []:
        # SHOW output keys are lower-case; be tolerant of either casing.
        def get(k):
            return row.get(k) or row.get(k.upper())
        d, s, n = get(db), get(schema), get(name)
        if d and s and n:
            out.add(f"{d}.{s}.{n}".upper())
    return out


def available(connection: str):
    """What this account can back an agent spec with, or None if unknown.

    Returns (tool_targets, mcp_targets): semantic views + cortex search services
    for the `tools` / `tool_resources` path, and MCP servers for the
    `mcp_servers` path. Kept as two sets because the two spec sections are pruned
    independently and a miss in each has a different consequence.
    """
    sv = snow_json(connection, "SHOW SEMANTIC VIEWS IN ACCOUNT;")
    css = snow_json(connection, "SHOW CORTEX SEARCH SERVICES IN ACCOUNT;")
    mcp = snow_json(connection, "SHOW MCP SERVERS IN ACCOUNT;")
    if sv is None or css is None or mcp is None:
        return None
    return fqns(sv) | fqns(css), fqns(mcp)


def target_of(resource) -> str | None:
    """The FQN a tool_resources entry depends on, if it has one."""
    if not isinstance(resource, dict):
        return None
    for key in ("semantic_view", "name"):
        value = resource.get(key)
        if isinstance(value, str) and value.count(".") == 2:
            return value
    return None


def prune_tools(spec: dict, have: set) -> list:
    resources = spec.get("tool_resources")
    if not isinstance(resources, dict):
        return []

    removed = []
    for tool_name, resource in list(resources.items()):
        target = target_of(resource)
        if target and target.upper() not in have:
            removed.append((tool_name, target))
            del resources[tool_name]

    if removed:
        gone = {name for name, _ in removed}
        spec["tools"] = [
            tool for tool in spec.get("tools", [])
            if (tool.get("tool_spec", tool) or {}).get("name") not in gone
        ]
    return removed


def prune_mcp_servers(spec: dict, have_mcp: set) -> list:
    """Drop mcp_servers entries whose server does not exist. Returns the FQNs."""
    servers = spec.get("mcp_servers")
    if not isinstance(servers, list):
        return []

    removed, kept = [], []
    for entry in servers:
        target = None
        if isinstance(entry, dict):
            spec_block = entry.get("server_spec")
            if isinstance(spec_block, dict):
                value = spec_block.get("name")
                if isinstance(value, str) and value.count(".") == 2:
                    target = value
        # An entry with no resolvable FQN is left alone rather than guessed at:
        # this script only ever removes things it can positively prove missing.
        if target and target.upper() not in have_mcp:
            removed.append(target)
        else:
            kept.append(entry)

    if removed:
        spec["mcp_servers"] = kept
    return removed


def prune(spec: dict, have: set, have_mcp: set) -> tuple[dict, list, list]:
    removed_tools = prune_tools(spec, have)
    removed_mcp = prune_mcp_servers(spec, have_mcp)
    return spec, removed_tools, removed_mcp


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--connection", required=True)
    ap.add_argument("--out-dir", required=True)
    ap.add_argument("specs", nargs="+")
    args = ap.parse_args()

    probed = available(args.connection)
    if probed is None:
        print("[prune_agent_specs] WARN: could not inspect the account; "
              "using specs unchanged", file=sys.stderr)
        return 2
    have, have_mcp = probed

    out_dir = pathlib.Path(args.out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)

    total = 0
    total_mcp = 0
    for path_str in args.specs:
        path = pathlib.Path(path_str)
        spec = json.loads(path.read_text())
        spec, removed, removed_mcp = prune(spec, have, have_mcp)
        (out_dir / path.name).write_text(json.dumps(spec, indent=2))
        for tool_name, target in removed:
            total += 1
            print(f"[prune_agent_specs] {path.name}: dropped tool {tool_name!r} "
                  f"- {target} does not exist in this account")
        for target in removed_mcp:
            total_mcp += 1
            print(f"[prune_agent_specs] WARN: {path.name}: dropped MCP server "
                  f"{target} - it does not exist in this account, so EVERY verb it "
                  f"publishes is unavailable to this agent. Install the owning "
                  f"synapse bundle and re-run create_agents.sh to restore them.",
                  file=sys.stderr)

    if total == 0 and total_mcp == 0:
        print("[prune_agent_specs] all agent tool and MCP server targets exist; "
              "nothing pruned")
    else:
        print(f"[prune_agent_specs] dropped {total} tool(s) and {total_mcp} MCP "
              "server(s) with a missing target. Re-run this script after "
              "installing the owning pack or bundle to restore them.")
    return 0


if __name__ == "__main__":
    sys.exit(main())

#!/usr/bin/env python3
"""Fail when a synapse verb has no routing guidance in the agents bound to it.

Why this exists
---------------
A synapse verb is auto-discovered: `npx synapse deploy` walks `src/procs/` and
publishes every verb it finds on the MCP server, with its description and a
generated JSON input schema. Nothing needs to reference it. Because the agent
specs attach whole MCP servers (`mcp_servers[].server_spec.name`, no tool
allowlist), a newly added verb is therefore immediately VISIBLE to every agent
bound to that bundle.

Visible is not the same as used well. Without a routing line in
`instructions.orchestration` the model has only the verb's own description to go
on, and two things go wrong, neither of which fails anything:

* the verb is ignored, and the agent answers a question it had a purpose-built
  tool for by some worse route; or
* the verb is preferred over a better tool - the documented hazard being
  `run_sql` winning over a `query_*` Cortex Analyst tool, which silently
  bypasses the governed semantic-view path.

This is the exact class of defect AGENTS.md warns about ("a new synapse verb is
auto-discovered, but the agent will not use it well until a spec tells it to")
and it had already happened four times when this gate was written: `evac_seed`,
`evac_solve` and `vrp_solve` were unmentioned in the consumer and super agents,
and `recent_verb_attempts` was unmentioned in the ops agent that owns it - while
the SUPER agent did describe it, so the role-specific agent was the weaker of
the two at reading its own audit trail.

How the binding is derived
--------------------------
Which agents a verb must be documented in follows from which MCP servers each
spec attaches, not from a hand-kept list here: the bundle-to-spec map below is
asserted against the `mcp_servers` block of each spec, so moving a server
between agents cannot silently drift from this gate.

What it deliberately does NOT do
--------------------------------
* It does not check WHERE in the instructions a verb is named, or that the
  guidance is any good. Substring presence is a floor, not a quality bar; the
  ceiling is an eval case, which needs a live stack and belongs in
  `.cortex/skills/evals/`.
* It does not require a verb to appear in the `tools` array. MCP verbs never do
  - that array holds only native tools (Cortex Analyst / Search / chart).
* It does not police native tool coverage, which `prune_agent_specs.py` and the
  view-catalog gate already cover from the other direction.

Usage:  python3 check_agent_verb_coverage.py
Exit:   0 clean, 1 a verb is unguided in an agent that can see it
"""
from __future__ import annotations

import json
import pathlib
import re
import sys

SKILL = pathlib.Path(__file__).resolve().parent.parent
TOOLS = SKILL / "fleet_tools"
SPECS = SKILL / "fleet_sa_app" / "app"

CONSUMER = "agent-spec.json"
OPS = "ops-agent-spec.json"
ADMIN = "admin-agent-spec.json"
SUPER = "super-agent-spec.json"

# The MCP server each bundle publishes, and the specs expected to attach it.
# `verify_bindings` asserts the second column against the specs themselves, so a
# server moved between agents fails loudly here instead of quietly narrowing
# what this gate checks.
BUNDLES = {
    "user": ("OPENROUTESERVICE_APP.ROUTING.ROUTING_MCP", [CONSUMER, SUPER]),
    "ops": ("FLEET_INTELLIGENCE.SYNAPSE_OPS.FLEET_OPS_MCP", [OPS, SUPER]),
    "admin": ("FLEET_INTELLIGENCE.SYNAPSE_ADMIN.FLEET_ADMIN_MCP", [ADMIN, SUPER]),
}

# Verbs deliberately reachable but not advertised, as {(bundle, verb): reason}.
# A reason is mandatory - an entry without one is rejected - so silencing this
# gate is a decision on the record rather than a one-word edit.
ALLOWLIST: dict[tuple[str, str], str] = {}

NAME_RE = re.compile(r"^\s{2}name:\s*'([a-z0-9_]+)'", re.MULTILINE)


def verbs_of(bundle: str) -> dict[str, str]:
    """Verb name -> defining file, read from the proc's declared `name`.

    The declared name is authoritative rather than the filename: they agree
    today, but the MCP server publishes the declared one, so a future mismatch
    would make a filename-based gate check a verb that does not exist.
    """
    procs = TOOLS / bundle / "src" / "procs"
    found: dict[str, str] = {}
    for path in sorted(procs.glob("*.ts")):
        match = NAME_RE.search(path.read_text())
        found[match.group(1) if match else path.stem] = path.name
    return found


def instructions_text(spec_name: str) -> str:
    spec = json.loads((SPECS / spec_name).read_text())
    return json.dumps(spec.get("instructions", {}))


def attached_servers(spec_name: str) -> set[str]:
    spec = json.loads((SPECS / spec_name).read_text())
    out = set()
    for entry in spec.get("mcp_servers") or []:
        name = ((entry or {}).get("server_spec") or {}).get("name")
        if isinstance(name, str):
            out.add(name.upper())
    return out


def verify_bindings() -> list[str]:
    """Check BUNDLES matches what the specs actually attach."""
    problems = []
    all_specs = [CONSUMER, OPS, ADMIN, SUPER]
    attached = {name: attached_servers(name) for name in all_specs}
    for bundle, (server, expected) in BUNDLES.items():
        for spec_name in all_specs:
            has = server.upper() in attached[spec_name]
            should = spec_name in expected
            if has and not should:
                problems.append(
                    f"{spec_name} attaches {server} ({bundle} bundle) but this "
                    f"gate does not expect it to - add {spec_name} to "
                    f"BUNDLES['{bundle}'] so its verbs are checked there too")
            elif should and not has:
                problems.append(
                    f"{spec_name} is expected to attach {server} ({bundle} "
                    f"bundle) but does not - either the spec lost its MCP "
                    f"binding or BUNDLES is stale")
    return problems


def main() -> int:
    print("Agent verb coverage (synapse verbs vs agent orchestration guidance)")
    print()

    for (bundle, verb), reason in ALLOWLIST.items():
        if not str(reason).strip():
            print("FAILED: agent-verb-coverage check")
            print(f"  - allowlist entry ({bundle}, {verb}) has no reason")
            return 1

    binding_problems = verify_bindings()

    text = {name: instructions_text(name)
            for name in (CONSUMER, OPS, ADMIN, SUPER)}
    problems: list[str] = []
    total = 0

    for bundle, (_server, specs) in BUNDLES.items():
        found = verbs_of(bundle)
        if not found:
            problems.append(
                f"no verbs found under fleet_tools/{bundle}/src/procs - the gate "
                f"derives its verb list from there, so an empty list would pass "
                f"every spec silently")
            continue
        total += len(found)
        unguided = []
        for verb, filename in sorted(found.items()):
            if (bundle, verb) in ALLOWLIST:
                continue
            for spec_name in specs:
                if verb not in text[spec_name]:
                    unguided.append((verb, filename, spec_name))
        state = f"{len(unguided)} unguided" if unguided else "clean"
        print(f"  {bundle:6s} {len(found):3d} verbs -> "
              f"{', '.join(specs):48s} {state}")
        for verb, filename, spec_name in unguided:
            problems.append(
                f"{bundle}/{filename}: verb {verb!r} is published on "
                f"{BUNDLES[bundle][0]} and therefore visible to {spec_name}, "
                f"but that spec's instructions never name it")

    print(f"  {'':6s} {total:3d} verbs total")
    print()

    if binding_problems:
        print("FAILED: agent-verb-coverage check (MCP binding mismatch)")
        for p in binding_problems:
            print(f"  - {p}")
        return 1

    if problems:
        print("FAILED: agent-verb-coverage check")
        for p in problems:
            print(f"  - {p}")
        print()
        print("  Add a routing line to the spec's instructions.orchestration "
              "saying when to")
        print("  prefer this verb (and when not to). If a verb is deliberately "
              "unadvertised,")
        print("  add it to ALLOWLIST in this file with a reason.")
        print("  Remember super-agent-spec.json is GENERATED - edit the role "
              "spec, then run")
        print("  python3 scripts/build_super_agent_spec.py")
        return 1

    print("PASSED: every synapse verb is named in the instructions of each "
          "agent that can see it")
    return 0


if __name__ == "__main__":
    sys.exit(main())

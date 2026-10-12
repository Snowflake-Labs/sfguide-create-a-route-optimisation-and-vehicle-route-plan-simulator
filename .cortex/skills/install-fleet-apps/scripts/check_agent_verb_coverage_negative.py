#!/usr/bin/env python3
"""Negative tests for check_agent_verb_coverage.py - each case makes a synapse
verb visible to an agent whose instructions never name it (the four shipped
cases were evac_seed/evac_solve/vrp_solve in the consumer agent and
recent_verb_attempts in the ops agent), or lets the bundle-to-spec binding drift,
and the gate must name the verb, the spec or the binding."""
import json
import pathlib
import sys

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
from negtest import Harness  # noqa: E402

SKILL = ".cortex/skills/install-fleet-apps"
APP = f"{SKILL}/fleet_sa_app/app"
USER_PROCS = f"{SKILL}/fleet_tools/user/src/procs"
ADMIN_PROCS = f"{SKILL}/fleet_tools/admin/src/procs"
OPS_MCP = "FLEET_INTELLIGENCE.SYNAPSE_OPS.FLEET_OPS_MCP"
USER_MCP = "OPENROUTESERVICE_APP.ROUTING.ROUTING_MCP"

h = Harness("check_agent_verb_coverage.py")


def spec_case(name: str, spec: str, fn, expect: str) -> None:
    p = h.path(f"{APP}/{spec}")
    original = p.read_text()

    def apply():
        d = json.loads(original)
        fn(d)
        changed = json.dumps(d, indent=2, ensure_ascii=False) + "\n"
        assert changed != original
        p.write_text(changed)

    h.custom(name, apply, lambda: p.write_text(original), expect)


def unname(verb: str, alias: str):
    """Remove every mention of `verb` from a spec's instructions."""
    def fn(d):
        text = json.dumps(d["instructions"], ensure_ascii=False)
        assert verb in text, f"{verb} not in instructions"
        d["instructions"] = json.loads(text.replace(verb, alias))
    return fn


# A brand-new verb: auto-discovered and published, named by no agent.
h.add(f"{USER_PROCS}/negtest_probe.ts",
      "import { defineProc, t } from '@snowflake/synapse';\n\n"
      "export const negtest_probe = defineProc({\n"
      "  name: 'negtest_probe_verb',\n"
      "  description: 'probe',\n"
      "  roles: ['user'],\n"
      "  args: {},\n"
      "  returns: { result: t.object({}) },\n"
      "  execute: async () => ({ result: {} }),\n"
      "});\n",
      expect=f"verb 'negtest_probe_verb' is published on {USER_MCP} and therefore visible to agent-spec.json",
      name="new user verb named by no agent")

# The shipped cases: the role agent that owns a verb never names it.
spec_case("ops agent never names recent_verb_attempts", "ops-agent-spec.json",
          unname("recent_verb_attempts", "the audit trail verb"),
          expect="verb 'recent_verb_attempts' is published on "
                 f"{OPS_MCP} and therefore visible to ops-agent-spec.json")
spec_case("consumer agent never names evac_seed", "agent-spec.json",
          unname("evac_seed", "the evacuation seeding step"),
          expect="verb 'evac_seed' is published on "
                 f"{USER_MCP} and therefore visible to agent-spec.json")

# The declared name, not the filename, is what the MCP server publishes.
h.replace(f"{USER_PROCS}/vrp_solve.ts", "  name: 'vrp_solve',", "  name: 'vrp_solve_generic',",
          expect="verb 'vrp_solve_generic'", name="declared verb name drifts from the filename")

# Binding drift, both directions.
spec_case("super agent loses the ops MCP binding", "super-agent-spec.json",
          lambda d: d.__setitem__("mcp_servers", [s for s in d["mcp_servers"]
                                                  if s["server_spec"]["name"] != OPS_MCP]),
          expect=f"super-agent-spec.json is expected to attach {OPS_MCP}")
spec_case("ops agent attaches the user MCP unexpectedly", "ops-agent-spec.json",
          lambda d: d["mcp_servers"].append({"server_spec": {"name": USER_MCP}}),
          expect=f"ops-agent-spec.json attaches {USER_MCP} (user bundle) but this gate does not expect it")

# An empty verb list must not pass every spec silently.
admin_dir = h.path(ADMIN_PROCS)
moved = h.path(f"{SKILL}/fleet_tools/admin/src/procs_moved")
h.custom("admin procs directory moved away (vacuity)",
         lambda: admin_dir.rename(moved), lambda: moved.rename(admin_dir),
         expect="no verbs found under fleet_tools/admin/src/procs")

# Silencing the gate needs a reason on the record.
h.replace(f"{SKILL}/scripts/check_agent_verb_coverage.py",
          "ALLOWLIST: dict[tuple[str, str], str] = {}",
          "ALLOWLIST: dict[tuple[str, str], str] = {(\"user\", \"run_sql\"): \"\"}",
          expect="allowlist entry (user, run_sql) has no reason", name="allowlist entry without a reason")

sys.exit(h.finish())

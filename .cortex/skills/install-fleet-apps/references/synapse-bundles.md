# Synapse tool bundles (per-account)

Three role-scoped synapse apps, each producing its OWN Snowflake-managed MCP
server (per-bundle servers = role isolation):

| Source (`fleet_tools/<dir>/`) | App | MCP server | Role |
|---|---|---|---|
| `user/` | `routing-tools` | `OPENROUTESERVICE_APP.ROUTING.ROUTING_MCP` | `FLEET_APP_USER` |
| `ops/` | `fleet-ops-tools` | `FLEET_INTELLIGENCE.SYNAPSE_OPS.FLEET_OPS_MCP` | `FLEET_APP_OPS` |
| `admin/` | `fleet-admin-tools` | `FLEET_INTELLIGENCE.SYNAPSE_ADMIN.FLEET_ADMIN_MCP` | `FLEET_APP_ADMIN` |

Only `ROUTING_MCP` is attached to the consumer agent (`FLEET_AGENT`). `FLEET_OPS_MCP`
is attached to the separate, role-gated `FLEET_OPS_AGENT`; `FLEET_ADMIN_MCP` is
not attached to any agent. So an end-user agent session can never see an Ops or
Admin verb (Tenet 3).

## Install (per account)

```bash
bash .cortex/skills/install-fleet-apps/scripts/install_synapse_bundles.sh <connection>
```

The script:
1. Installs the vendored framework deps once (`fleet_tools/vendor/synapse`, public npm only).
2. Resolves the active account via `CURRENT_ACCOUNT()`.
3. For each bundle: `npm install`, generates a fresh per-account
   `_installed/<account>/<bundle>/install.json` (binds the active connection +
   the logical->actual role), then `npx synapse materialize` + `npx synapse deploy`.
4. Verifies with `SHOW MCP SERVERS`.

The committed `_installed/wgb26798/` targets are account-pinned references only;
the per-account script never reuses them, so a clean install works on any account.

## Engine coupling note

The User bundle's verbs wrap `FLEET_INTELLIGENCE.ROUTING_TOOLS.TOOL_*` ->
`ROUTING_PLATFORM.CONTRACT.*` -> the ORS provider. They install regardless of
engine state but only execute live routing when an ORS engine is present (see
`routing-engine.md`). `ROUTING_MCP` lives in `OPENROUTESERVICE_APP.ROUTING`
because it is part of the routing seam; relocating it to a FLEET-owned schema is
deferred to the optional full-absorption phase.

## Authoring gotchas (carried from the source bundles)

- `export const` name MUST equal the `defineProc({ name })` value (snake_case).
- Keep the materialize `--install` target dir SEPARATE from the bundle source
  dir; materialize writes a runtime `package.json` into the target.
- Do not use `LIKE ... ESCAPE '\'` in proc SQL; use `STARTSWITH`.

## MCP <-> agent invariants (do not regress)

Two load-bearing rules. Violating either reproduces the exact same symptom: the
agent says something like "the routing service is currently experiencing an
issue", `OPENROUTESERVICE_APP.ROUTING.VERB_ATTEMPT` shows NO row for the verb,
and the SSE tool event carries `MCP error calling tool ...: Error parsing
response`. Both were root-caused 2026-06-25.

1. **Verb procs MUST declare `IDEMPOTENCY_KEY STRING DEFAULT NULL`** (last arg).
   The Cortex Agent MCP server invokes each tool with NAMED args and OMITS
   `idempotency_key` (it is optional in the MCP `input_schema`, so the LLM does
   not pass it). The call looks like `CALL p(locations_description => ?, profile
   => ?)`. Without a default on the trailing arg, Snowflake raises *"named
   arguments [...] do not match any signature"* BEFORE the proc body runs (hence
   no audit row), and the agent surfaces it as the generic "Error parsing
   response". The default is emitted by the vendored generator
   `fleet_tools/vendor/synapse/dist/build/ddl.js` (`procDDL`, the
   `argEntries.push('IDEMPOTENCY_KEY STRING DEFAULT NULL')` line). Do NOT drop
   the `DEFAULT NULL` if that file is ever re-synced from upstream.

2. **Recreate the agents AFTER (re)deploying the bundles.** `npx synapse deploy`
   does `CREATE OR REPLACE MCP SERVER`, which replaces `ROUTING_MCP` /
   `FLEET_OPS_MCP` / `FLEET_ADMIN_MCP`. The agents bind to the MCP server at
   agent-creation time, so any bundle redeploy leaves the existing agents bound
   to a since-replaced server and they can no longer invoke the tools. The
   orchestrator (`install_fleet_apps.sh`) already runs bundles (step 5) before
   agents (step 6), so a fresh install is correct. But ANY out-of-band
   `install_synapse_bundles.sh` run (e.g. adding a verb, an evac/feature deploy)
   MUST be followed by `create_agents.sh <connection>`. Quick check: every agent
   `created_on` must be newer than its referenced MCP server `created_on`
   (`SHOW AGENTS IN SCHEMA FLEET_INTELLIGENCE.SYNAPSE_USER` vs `SHOW MCP SERVERS`).

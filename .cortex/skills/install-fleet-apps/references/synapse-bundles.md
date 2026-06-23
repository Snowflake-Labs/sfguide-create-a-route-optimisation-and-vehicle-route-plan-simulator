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

The User bundle's verbs wrap `FLEET_INTELLIGENCE.ROUTING_AGENT.TOOL_*` ->
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

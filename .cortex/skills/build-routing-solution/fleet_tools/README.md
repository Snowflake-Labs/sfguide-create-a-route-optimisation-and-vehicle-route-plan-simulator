# Fleet routing tools (synapse layer)

The typed, audited routing tool layer for the Fleet Intelligence app, authored with
[synapse](/Users/obielov/Documents/GitHub/synapse). Two **separate** synapse apps so each
produces its OWN Snowflake-managed MCP server (per-bundle servers = role isolation):

| App (`<app>/`) | Role | Procs | MCP server | Schema |
|---|---|---|---|---|
| `user/` | `user` | `get_directions`, `compute_isochrone`, `optimize_routes`, `find_poi`, `pharma_catchment` | `FLEET_USER_MCP` | `FLEET_INTELLIGENCE.SYNAPSE_USER` |
| `admin/` | `admin` | `set_active_region`, `check_substrate` | `FLEET_ADMIN_MCP` | `FLEET_INTELLIGENCE.SYNAPSE_ADMIN` |

Only `FLEET_USER_MCP` is attached to the consumer Cortex Agent. `FLEET_ADMIN_MCP` is bound to
the admin role and is not reachable by an end-user agent session.

## Design

- **Wrap, don't rewrite.** Each User verb is a thin `defineProc` whose `execute` does
  `CALL FLEET_INTELLIGENCE.ROUTING_AGENT.TOOL_*(...)` and returns the VARIANT. The synapse
  envelope adds typed args, validation, audit logging (`verb_attempt` HYBRID TABLE),
  idempotency (trailing `IDEMPOTENCY_KEY`), and role-scoped GRANTs over the proven procs.
- **Per-bundle MCP servers.** synapse emits one MCP server per app and roles only drive
  GRANTs (they do not hide tools within a server), so User and Admin are separate apps.

## Layout

```
fleet_tools/
  user/   admin/                 # synapse app sources (synapse.config.ts, src/procs/*.ts)
  _installed/wgb26798/
    fleet-user-tools/  fleet-admin-tools/   # materialize targets: install.json + emitted install.sql/runtime.js/server.js
```

## Build / deploy

```bash
# one-time: build the synapse framework (install ONLY the package; the workspace install hangs)
cd /Users/obielov/Documents/GitHub/synapse/packages/synapse && npm install && npm run build

# per app: install (file:-links synapse), materialize, deploy
cd fleet_tools/user
npm install
npx synapse materialize --install ../_installed/wgb26798/fleet-user-tools
npx synapse deploy      --install ../_installed/wgb26798/fleet-user-tools   # snow sql -f via fleet_test_evals
# repeat for fleet_tools/admin
```

`install.json` (in each `_installed/.../` target) binds logical roles to actual Snowflake roles
(`user`/`admin` -> `ACCOUNTADMIN` for now; production binds `FLEET_APP_USER` / `FLEET_APP_ADMIN`),
the `snowCliConn` (`fleet_test_evals` = wgb26798), warehouse, db, schema, and `mcpServerName`.

## Authoring gotchas (learned)

- The `export const` name MUST equal the `defineProc({ name })` value (snake_case) — the bundler
  imports by proc name.
- Keep the materialize `--install` target dir SEPARATE from the app source dir; materialize writes
  a runtime `package.json` into the target and would clobber the source one.
- Don't use `LIKE ... ESCAPE '\'` in proc SQL (Snowflake backslash mangling); use `STARTSWITH`.

## Caveat (tier C)

synapse is currently `file:`-linked from its own repo (absolute path). For a portable/forkable
quickstart, vendor the synapse package into this repo before publishing.

## Verified (wgb26798)

`SHOW MCP SERVERS` lists both servers. `check_substrate` ran through the envelope: `verb_attempt`
recorded `outcome=ok`, and a repeated idempotency key produced an `idempotent_replay` row. Live
routing verbs (`get_directions` etc.) require the ORS/VROOM SPCS services up — verify at deploy time.

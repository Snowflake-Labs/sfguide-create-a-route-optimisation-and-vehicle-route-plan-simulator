# Synapse tool bundles (per-account)

Three role-scoped synapse apps, each producing its OWN Snowflake-managed MCP
server (per-bundle servers = role isolation):

| Source (`fleet_tools/<dir>/`) | App | MCP server | Role |
|---|---|---|---|
| `user/` | `routing-tools` | `OPENROUTESERVICE_APP.ROUTING.ROUTING_MCP` | `FLEET_APP_USER` |
| `ops/` | `fleet-ops-tools` | `FLEET_INTELLIGENCE.SYNAPSE_OPS.FLEET_OPS_MCP` | `FLEET_APP_OPS` |
| `admin/` | `fleet-admin-tools` | `FLEET_INTELLIGENCE.SYNAPSE_ADMIN.FLEET_ADMIN_MCP` | `FLEET_APP_ADMIN` |

Agent attachment, per `scripts/create_agents.sh`:

| Agent | Spec | MCP server(s) attached | Granted to |
|---|---|---|---|
| `FLEET_AGENT` | `agent-spec.json` | `ROUTING_MCP` | `FLEET_APP_USER` |
| `FLEET_OPS_AGENT` | `ops-agent-spec.json` | `FLEET_OPS_MCP` | `FLEET_APP_OPS` |
| `FLEET_ADMIN_AGENT` | `admin-agent-spec.json` | `FLEET_ADMIN_MCP` | `FLEET_APP_ADMIN` |
| `FLEET_SUPER_AGENT` | `super-agent-spec.json` (GENERATED) | all three | `FLEET_APP_ADMIN` only |

A consumer agent session can never see an Ops or Admin verb (Tenet 3). The super
agent is the deliberate exception and it does NOT weaken that: the isolation
boundary is the GRANT, not the spec. `role_binding.sql` grants
`FLEET_SUPER_AGENT` to `FLEET_APP_ADMIN` only, and since the hierarchy is ADMIN
inherits OPS inherits USER, an admin already holds every MCP server it attaches.
Granting it to `FLEET_APP_USER` would hand every app user service suspension and
region deletion, with nothing else in the stack stopping them - so do not.

It exists because a Cowork / Snowflake Intelligence user cannot hand off between
agents mid-conversation, so an operator working there needs one assistant that
both answers analytics questions and operates the platform.

`super-agent-spec.json` is GENERATED from `agent-spec.json` by
`scripts/build_super_agent_spec.py` and must not be hand-edited. Two
hand-maintained copies of a 12,000-character instruction block drift within a
release, and the drift is invisible until the two agents answer the same question
differently. `create_agents.sh` regenerates it before deploying, and
`--check` fails a stale committed copy.

## Verb inventory

| Bundle | Verbs |
|---|---|
| user | `get_directions`, `compute_isochrone`, `optimize_routes`, `find_poi`, `catchment`, `delivery_optimization`, `network_optimization`, `snap_to_road`, `map_match`, `vrp_solve`, `evac_seed`, `evac_solve`, `query_overture_places`, `query_overture_addresses`, `introspect_sap`, `list_use_cases`, `describe_deployment`, `render_view`, **`describe_data`**, **`run_sql`**, **`deep_link`** |
| ops | `service_control`, `service_status`, `service_inventory`, `healthcheck`, `set_active_region`, `set_active_context`, `activate_dataset`, `recent_verb_attempts`, `describe_deployment`, **`provision_region`**, **`region_status`**, **`drop_region`**, **`list_datasets`**, **`cost_control`** |
| admin | `set_active_region`, `check_substrate`, `describe_deployment` |

Notes on the data-access and lifecycle verbs:

- **`run_sql` is read-only by allowlist, not by denylist.** The real boundary is
  the synapse role: the verb runs as `FLEET_APP_USER` and can only touch what
  that role already holds. The allowlist stops an accident, not a determined
  caller. Three guards, in order: comments and string literals are blanked BEFORE
  the leading keyword is read (a block comment cannot mask a `DROP`), any
  non-trailing semicolon is rejected (a piggybacked statement is refused even
  when the first statement is a valid `SELECT`), and the leading keyword must be
  in `SELECT / WITH / SHOW / DESCRIBE / DESC / EXPLAIN`. Regression test:
  `node --import tsx fleet_tools/user/verify_run_sql.mts` (27 cases).
- **`provision_region` cannot be synchronous.** A build runs for tens of minutes
  to hours, so the async launch lives in SQL
  (`OPENROUTESERVICE_APP.CORE.START_REGION_PROVISION`, a schedule-less TASK plus
  `EXECUTE TASK`). Enqueuing alone does not work: `RESCUE_PENDING_PROVISIONS`
  only FINALIZES stuck jobs, it never launches a PENDING one.
- **There is no `generate_dataset` verb.** Generation runs inside the admin app's
  Node process (`startGeneration`, in-memory job map + SSE + thousands of live
  routing calls), which a stored procedure cannot host.
  `OPENROUTESERVICE_APP.CORE.STUDIO_START_JOB` looks like a SQL entry point and
  is not: it launches a job service from an `ors_studio_worker` image built
  nowhere in this repo, with no tag in `image-versions.env`, called by nothing.
  Wrapping it would yield a verb that reports "launched" and generates nothing.
- **`cost_control` is one verb with an `action` argument** rather than four
  near-identical tools, because the four are one decision and agents pick badly
  between similarly-named siblings.

## Install (per account)

```bash
bash .cortex/skills/install-fleet-apps/scripts/install_synapse_bundles.sh <connection>
```

The script:
1. Installs the vendored framework deps (`fleet_tools/vendor/synapse`, public npm only)
   **and builds the framework from source with `tsc`**. See "Vendored framework is
   source, not dist" below - the `synapse` CLI does not exist until this runs.
2. Resolves the active account via `CURRENT_ACCOUNT()`.
3. For each bundle: `npm install`, generates a fresh per-account
   `_installed/<account>/<bundle>/install.json` (binds the active connection +
   the logical->actual role), then `npx synapse materialize` + `npx synapse deploy`.
4. Verifies with `SHOW MCP SERVERS`.

The committed `_installed/wgb26798/` targets are account-pinned references only;
the per-account script never reuses them, so a clean install works on any account.

## Vendored framework is source, not dist

`fleet_tools/vendor/synapse` holds upstream `packages/synapse` **source** pinned to a
SHA, with local patches applied on top; `dist/` is generated and is **not committed**.
Full provenance, the patch inventory, and the re-vendor procedure live in
[`../fleet_tools/vendor/synapse/VENDOR.md`](../fleet_tools/vendor/synapse/VENDOR.md).

Consequences when working on the bundles:

- `install_synapse_bundles.sh` runs `npm install` (including dev deps, for
  `typescript`) and `npm run build` before touching Snowflake, and **rebuilds whenever
  `src/` is newer than `dist/cli/index.js`**. A stale `dist` is the dangerous case: the
  deploy looks completely normal while emitting old codegen.
- The script then string-checks the built output for the two local codegen patches
  (procedure `COMMENT` positioned before `EXECUTE AS`, and the `install.sql`
  `query_tag` preamble) and aborts if either is missing, so a re-vendor that silently
  dropped a patch fails at install time rather than producing untagged objects.
- Each bundle's `@snowflake/synapse` is a `file:` dependency symlinked to the vendor
  directory, so a rebuild is picked up with no per-bundle reinstall.
- After changing framework source, run `npm test` in the vendor directory (72 tests);
  the DDL suite guards the patched clause order and the materialize suite guards the
  deploy-role precedence.

## install.json MUST bind a `deploy` role

The generated `install.sql` opens with `USE ROLE <deployRole>` and then creates the
`VERB_ATTEMPT` hybrid table, the verb procedures, the MCP server, and the grants, so
that role has to be installer-grade. `install_synapse_bundles.sh` therefore writes:

```json
"roles": { "deploy": "<CURRENT_ROLE()>", "<bundle role key>": "<FLEET_APP_*>" }
```

Do not drop the `deploy` binding. Our logical role names are the CONSUMER app roles
(`user` -> `FLEET_APP_USER`, `ops` -> `FLEET_APP_OPS`, `admin` -> `FLEET_APP_ADMIN`),
and the framework's fallback chain (`deploy` -> `admin` -> `owner` -> first key) would
otherwise land on one of those. `install.sql` then emits `USE ROLE FLEET_APP_USER` and
fails on `CREATE OR REPLACE HYBRID TABLE verb_attempt` for want of
`CREATE HYBRID TABLE` - before any procedure, the MCP server, or any grant is created,
so the bundle deploys **nothing**. Note that `admin` cannot serve as the deploy key:
the admin bundle's verbs declare `roles: ['admin']`, so it is already bound to a
consumer role. Full reasoning in
[`../fleet_tools/vendor/synapse/VENDOR.md`](../fleet_tools/vendor/synapse/VENDOR.md).

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
   response". The default is emitted by the generator
   `fleet_tools/vendor/synapse/src/build/ddl.ts` (`procDDL`, the
   `argEntries.push('IDEMPOTENCY_KEY STRING DEFAULT NULL')` line) and asserted by a
   unit test. As of the pinned vendor SHA this is **upstream behaviour**, not a local
   patch - upstream fixed the identical bug in `dc8827c3` - so a re-sync will not lose
   it. Verify it anyway after any re-vendor.

2. **Recreate the agents AFTER (re)deploying the bundles.** `npx synapse deploy`
   does `CREATE OR REPLACE MCP SERVER`, which replaces `ROUTING_MCP` /
   `FLEET_OPS_MCP` / `FLEET_ADMIN_MCP`. The agents bind to the MCP server at
   agent-creation time, so any bundle redeploy leaves the existing agents bound
   to a since-replaced server and they can no longer invoke the tools. The
   orchestrator (`install_fleet_apps.sh`) already runs bundles (step 5) before
   agents (step 6), so a fresh install is correct. But ANY out-of-band
   `install_synapse_bundles.sh` run (e.g. adding a verb, an evac/feature deploy)
   MUST be followed by `create_agents.sh <connection>`. This now applies to FOUR
   agents, `FLEET_SUPER_AGENT` included - it attaches all three MCP servers, so
   it goes stale when ANY bundle is redeployed, not just one. Quick check: every
   agent `created_on` must be newer than its referenced MCP server `created_on`
   (`SHOW AGENTS IN SCHEMA FLEET_INTELLIGENCE.SYNAPSE_USER` vs `SHOW MCP SERVERS`).

3. **A new verb needs no registration, but the agent needs to be told about it.**
   Procs are auto-discovered by a directory walk of `src/procs/`
   (`vendor/synapse/src/build/discover.ts`), so adding a file is enough for the
   MCP server. It is NOT enough for the agent: without a routing line in the
   relevant spec's `instructions.orchestration`, the agent either ignores the verb
   or reaches for it ahead of a better tool. The specific failure that matters
   here is `run_sql` being preferred over a `query_*` semantic-view tool, which
   silently bypasses the governed path - hence the explicit
   "prefer a query_* tool whenever one models the data" rule in every spec.

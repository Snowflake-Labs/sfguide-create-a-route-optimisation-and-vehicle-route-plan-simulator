# Vendored `@snowflake/synapse`

This directory is a vendored copy of the synapse framework. It is **source**, built
locally with `tsc`; `dist/` is generated and gitignored.

## Upstream provenance

| Field | Value |
|---|---|
| Repository | `snowflake-eng/synapse` (private) |
| Path | `packages/synapse` |
| Pinned commit | `df8725cffe1d649221e79e50aaedf472288b41fa` |
| Vendored on | 2026-08-31 |
| Framework's own last change | 2026-07-14 (`eef84565`) |

Note on upstream cadence: the repo is very active, but the **framework package** is
not. All 100+ commits between 2026-07-15 and the pinned SHA land in `apps/` or
`deploy/`, never in `packages/synapse`. So a re-sync is usually a no-op for us; check
`git log --oneline -- packages/synapse` upstream before doing the work. Patterns worth
taking from those app commits are surveyed separately in
[../../references/upstream-synapse-app-patterns.md](../../references/upstream-synapse-app-patterns.md).

## What is vendored

`src/`, `tests/`, `tsconfig.json`, `vitest.config.ts`, `package.json`, `README.md`,
copied verbatim from the pinned commit, then the patches below are applied on top.
The only file here with no upstream counterpart is `src/tracking.ts`.

Previously only the prebuilt `dist/` was vendored, with the patches applied directly
to emitted JavaScript. That made the local changes invisible to review and impossible
to diff against upstream. Vendoring source fixes both.

`.gitignore` note: the repo-wide `build/` rule would swallow the framework's own
`src/build/` module - which holds the patched `ddl.ts` - with no error. There is an
explicit un-ignore for it. Do not remove it.

## Local patches (MUST survive every re-vendor)

Four deviations from upstream, plus two new local files. Each is load-bearing: dropping
one does not degrade gracefully, it breaks a fresh install. `patches/*.patch` are the
replayable record and are already applied to this tree. Patches are scoped by FILE, not
by concern, so `git apply` never has two patches editing the same file.

### patches/01-tracking-tags.patch

Files: new `src/tracking.ts`, `src/ddl.ts`, `src/build/ddl.ts`.
(The `query_tag` half of this concern lives in `04-cli-materialize.patch`, because that
file carries a second unrelated change and patches are kept file-scoped.)
Origin: repo commits `7c7db973` and `13943c91`.

AGENTS.md requires a session `query_tag` on every session and a JSON `COMMENT`
tracking tag on every created object. The materialized `install.sql` is generated
**and gitignored**, so the tags cannot be added to the output - they must come from
the generator. `src/tracking.ts` holds the two literals so the three call sites
cannot drift:

- `src/ddl.ts` - `COMMENT` on the `VERB_ATTEMPT` hybrid table
- `src/build/ddl.ts` - `COMMENT` on each generated procedure
- `src/cli/materialize.ts` - `ALTER SESSION SET query_tag` in the `install.sql` preamble (shipped in patch 04)

**The procedure `COMMENT` must sit BEFORE `EXECUTE AS`.** Upstream emits
`... EXECUTE AS OWNER AS`; appending `COMMENT` after `EXECUTE AS` makes Snowflake
reject the statement with "unexpected COMMENT", which aborts `synapse deploy` for the
whole bundle, so **no MCP servers get created** and the agent silently has no tools.
Guarded by the `emits the tracking COMMENT before EXECUTE AS` test.

Known exception: `CREATE MCP SERVER` has no `COMMENT` clause; MCP servers are tracked
via their JSON-tagged parent schema.

### patches/02-test-fixtures.patch

Files: `tests/unit/ddl.test.ts`, `tests/unit/bundle.test.ts`, new `tests/unit/materialize.test.ts`.

Test-only. Two of these are **upstream bugs**, not our changes, and are candidates for
an upstream PR:

- `dc8827c3` gave `bundleProc` a required third `catalog` argument but did not update
  the fixtures, so all 7 bundle tests threw `Cannot read properties of undefined
  (reading 'database')`. A shared `CATALOG` const is now passed at each call site.
- The same commit changed the emitted arg to `IDEMPOTENCY_KEY STRING DEFAULT NULL` but
  left the assertion on the old `IDEMPOTENCY_KEY STRING)` form.

The third hunk is ours: the clause-order guard described above.

### patches/03-audit-table-fqn.patch

File: `src/build/bundle.ts`.

Qualifies the audit table with the install target's `database.schema` when
substituting `__SYNAPSE_AUDIT_TABLE__`.

Apps declare `audit: { table: 'verb_attempt' }` in `synapse.config.ts`, which the CLI
evaluates **outside a bundle** - so `defineCatalog` cannot qualify it and the name
arrives bare. The emitted proc body then runs `INSERT INTO verb_attempt`, resolved
against whatever schema the **session** has at call time, which is not the deploy-time
schema: agent and MCP callers arrive with their own context. This is the same failure
mode `catalog.ts` was added upstream to eliminate, just on the audit path, which
`defineCatalog` structurally cannot reach.

The bundler already receives the target, so it qualifies the name. It is the same
table either way - this is robustness, not a bug fix; the audit trail works today.
An already-qualified name (contains a `.`) passes through untouched, and with no
target the bare name is preserved. Three tests cover those cases.

### patches/04-cli-materialize.patch

File: `src/cli/materialize.ts`. Carries two unrelated changes, because patches are
file-scoped.

**(a) The `install.sql` `query_tag` preamble** - the second half of the tracking-tag
concern described under patch 01.

**(b) `deploy` as the highest-precedence deploy role.** This one is a **total deploy
failure** if dropped, and it is the subtlest trap in this vendor directory.

`install.sql` emits `USE ROLE <deployRole>` and then creates the audit hybrid table,
the verb procedures, the MCP server, and the grants - so the deploy role must be
installer-grade. Upstream picks it as:

```ts
roles.admin ?? roles.owner ?? Object.values(roles)[0]
```

on the assumption that the logical role named `admin` is an installer role. In this
repo the logical names are the **consumer app roles**, declared by the verbs' own
`roles: [...]` fields and bound one-per-bundle by `install_synapse_bundles.sh`:

| Bundle | `install.json` roles | upstream picks | why |
|---|---|---|---|
| user | `{"user": "FLEET_APP_USER"}` | `FLEET_APP_USER` | first-key fallback |
| ops | `{"ops": "FLEET_APP_OPS"}` | `FLEET_APP_OPS` | first-key fallback |
| admin | `{"admin": "FLEET_APP_ADMIN"}` | `FLEET_APP_ADMIN` | matches `roles.admin` |

Every bundle therefore emits `USE ROLE <consumer role>` and dies on
`CREATE OR REPLACE HYBRID TABLE verb_attempt` for want of `CREATE HYBRID TABLE`,
before a single procedure, the MCP server, or any grant is created. Nothing installs.

Note this was **not** a pre-existing condition: the previously vendored `dist` emitted
no `USE ROLE` at all, so `install.sql` simply ran as the connection's role. The pin
arrived with the re-vendor.

Rebinding `admin` to an installer role does **not** fix it: the admin bundle's verbs
declare `roles: ['admin']`, `build/install.ts` hard-fails when a proc-referenced
logical role is unbound, and rebinding would mis-target that bundle's
`GRANT USAGE ON PROCEDURE` at the installer role. Hence a dedicated `deploy` key that
no verb can reference (verified unused across all 26 verbs). The rest of upstream's
chain is preserved, so an app where `admin` genuinely is the installer role is
unaffected.

`install_synapse_bundles.sh` binds `deploy` to `CURRENT_ROLE()`, which reproduces the
pre-pin behaviour exactly and keeps object ownership where it already was. Guarded by
`tests/unit/materialize.test.ts` and by a string check in the install script.

Upstream-PR candidate: the precedence silently deploys as an under-privileged role for
any app whose `admin` role is an app role rather than an installer role.

### Retired: `IDEMPOTENCY_KEY STRING DEFAULT NULL`

Repo commit `f23abece` patched the vendored dist to add this default, because the
Cortex Agent MCP server calls verbs with **named** arguments and omits the optional
`idempotency_key`; without a default Snowflake raises "named arguments [...] do not
match any signature" before the body runs, so there is no `VERB_ATTEMPT` row and the
agent reports a generic "Error parsing response".

Upstream fixed the identical bug independently in `dc8827c3`, so at the pinned SHA
`src/build/ddl.ts` already emits `IDEMPOTENCY_KEY STRING DEFAULT NULL`. **Do not
reapply this patch.** The behaviour is still verified by
`appends IDEMPOTENCY_KEY STRING DEFAULT NULL as the last arg`.

## Re-vendoring procedure

1. Check whether upstream `packages/synapse` actually changed since the pinned SHA. If not, stop.
2. Copy `src/`, `tests/`, `tsconfig.json`, `vitest.config.ts`, `package.json`, `README.md` from the new commit. Keep `src/tracking.ts` - it has no upstream counterpart.
3. Re-apply the patches:
   ```bash
   git apply patches/*.patch
   ```
   If a patch does not apply, reseat it by hand - upstream may have moved the code - then regenerate the patch file by diffing this tree against the fresh upstream copy.
4. `npm install && npm run build && npm test` (expect 72 passing).
5. Re-materialize and re-deploy the three bundles, then **recreate the agents** (`synapse deploy` does `CREATE OR REPLACE MCP SERVER`, so agents bound to the old server go stale).
6. Assert the generated `install.sql` still carries `query_tag`, per-procedure `COMMENT` positioned before `EXECUTE AS`, `IDEMPOTENCY_KEY STRING DEFAULT NULL`, and `USE ROLE <installer role>` (NOT a `FLEET_APP_*` consumer role) ahead of the hybrid-table DDL.
7. Update the pinned commit and date in this file.

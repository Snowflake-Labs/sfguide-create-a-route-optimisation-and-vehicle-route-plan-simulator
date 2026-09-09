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

Six deviations from upstream, plus two new local files. Each is load-bearing: dropping
one does not degrade gracefully, it breaks a fresh install. `patches/*.patch` are the
replayable record and are already applied to this tree. Patches 01-05 are scoped by FILE,
not by concern, so `git apply` never has two of them editing the same file.

**Patch 06 is the documented exception.** It is scoped by CONCERN (one behavioral change
spanning nine files, several already touched by 01-05), because the change is not
separable by file without splitting one guard across five patches. It is a diff of the
post-01-05 tree, so it MUST be applied last - `git apply patches/*.patch` does that
naturally, since shell glob order is lexicographic. Do not reorder it.

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

File: `src/cli/materialize.ts`. Carries three unrelated changes, because patches are
file-scoped.

**(a) The `install.sql` `query_tag` preamble** - the second half of the tracking-tag
concern described under patch 01.

**(c) A `COMMENT` tracking tag on the bundle `CREATE DATABASE` / `CREATE SCHEMA`.**
Both statements are `IF NOT EXISTS` inside an exception-swallowing `EXECUTE IMMEDIATE`,
so on the normal install path (installer pre-creates the target) they no-op and the tag
is irrelevant. On a **fresh account** they are what actually creates the bundle database
and schema. That matters more than a typical missing tag because `src/tracking.ts`
designates the parent schema as the tracking proxy for `CREATE MCP SERVER`, which has no
COMMENT clause of its own - so an untagged schema leaves the MCP server untracked
entirely. Guarded by a string check in `install_synapse_bundles.sh`.

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

### patches/05-connector-query-tag.patch

File: `src/connector.ts`.

AGENTS.md requires the tracking `query_tag` on every session. This connection had
none. It is the one used by `synapse deploy`, `synapse test-e2e`, and the stdio MCP
server, so every statement it issued - including the audited envelope's own
`VERB_ATTEMPT` inserts - was unattributable in `QUERY_HISTORY`.

The tag is applied by an `applyQueryTag()` helper awaited in BOTH connect paths
(`connectAndWrap`, used by `createConn`, and `createConnFromCli`, which cannot pass
connect options because the SDK only reads `connections.toml` when
`createConnection()` is called with no arguments). The Node SDK has no
`sessionParameters` connect option - that is the Python connector - so an explicit
`ALTER SESSION` right after connect is the only mechanism.

Note this does NOT cover verbs invoked through the Snowflake-managed MCP server:
that session is not code-controlled, so no change here can tag it. The deployed
procedures carry their own COMMENT tag instead.

### patches/06-idempotency-claim.patch

Files: `src/ddl.ts`, `src/audit.ts`, `src/errors.ts`, `src/runtime/envelope.ts`,
`src/runtime/sproc.ts`, `src/build/install-sql.ts`, `src/build/bundle.ts`,
`src/cli/materialize.ts`, `src/testing/index.ts`, plus tests.

Closes a double-execution race in the idempotency path. `checkReplay` in `audit.ts` is a
read-before-write with no transaction, no lock, and no unique constraint, so two concurrent
calls carrying the same `(actor, verb, idempotency_key)` both miss the replay check and both
run `execute()`. For the mutating verbs (`service_control`, `drop_region`, `activate_dataset`)
that is exactly the duplicate idempotency is supposed to prevent. Nothing upstream
acknowledges it.

This cannot be fixed with a `UNIQUE` constraint on `verb_attempt`, because that table
intentionally holds MULTIPLE rows per key (the original `ok`/`error` plus one
`idempotent_replay` per repeat). So the claim gets its own table, `verb_claim`, whose
PRIMARY KEY *is* the idempotency triple, and the insert happens BEFORE `execute()`: first
caller wins, the loser re-checks for a terminal row and replays it, or fails
`CONCURRENT_ATTEMPT` rather than re-executing.

Only a HYBRID table ENFORCES that primary key. Measured on wgb26798: the hybrid table
rejects the duplicate with `A primary key already exists.`, while the same DDL as a
standard table accepts both rows - so an unconditional insert would always succeed on
the accounts that have no hybrid tables (GCP, trial, SnowGov), and the guard would
silently permit the double execution it exists to block. `claim()` therefore does NOT
rely on a violation being raised: it issues a `WHERE NOT EXISTS` conditional insert and
reads the inserted-row count, which was measured to return 1 then 0 on BOTH table kinds
(and no PK error on the hybrid repeat), so the guard holds against a repeat claim
everywhere in a single statement. The PK-violation catch stays because it covers the one
case the predicate cannot - two callers passing `NOT EXISTS` simultaneously - which is
also the exact residual gap on a standard table. `claimTableDDL()` still follows the
audit table's `hybrid` flag; the difference is that the non-hybrid path is now degraded
rather than inert.

Two incidental properties worth preserving on a re-vendor:

- `AuditSink.claim` is OPTIONAL, so a sink written against the upstream interface still
  satisfies the type and keeps the old behavior. The envelope calls it only when present
  AND an idempotency key was supplied.
- Zero added cost on the agent path. The Cortex Agent MCP server omits `idempotency_key`
  (see `../../references/synapse-bundles.md`), so `claim` returns early without a statement.
  Independently, this patch also folds the separate `SELECT SHA2(?)` round trip into the
  audit `INSERT`, taking the success path from 3 statements to 2.

`verb_claim` needs no extra grant: every generated proc is `EXECUTE AS OWNER`, so the owner
writes it, exactly as for `verb_attempt`. Rows outlive the 24h replay window and are NOT
pruned on the request path (that would add a statement per verb); prune out of band with
`DELETE FROM <schema>.verb_claim WHERE claimed_at < DATEADD(day, -7, CURRENT_TIMESTAMP());`.

## Re-vendoring procedure

1. Check whether upstream `packages/synapse` actually changed since the pinned SHA. If not, stop.
2. Copy `src/`, `tests/`, `tsconfig.json`, `vitest.config.ts`, `package.json`, `README.md` from the new commit. Keep `src/tracking.ts` - it has no upstream counterpart.
3. Re-apply the patches:
   ```bash
   git apply patches/*.patch
   ```
   If a patch does not apply, reseat it by hand - upstream may have moved the code - then regenerate the patch file by diffing this tree against the fresh upstream copy.
4. `npm install && npm run build && npm test` (expect 87 passing).
5. Re-materialize and re-deploy the three bundles, then **recreate the agents** (`synapse deploy` does `CREATE OR REPLACE MCP SERVER`, so agents bound to the old server go stale).
6. Assert the generated `install.sql` still carries `query_tag`, per-procedure `COMMENT` positioned before `EXECUTE AS`, `IDEMPOTENCY_KEY STRING DEFAULT NULL`, and `USE ROLE <installer role>` (NOT a `FLEET_APP_*` consumer role) ahead of the hybrid-table DDL. Also assert BOTH hybrid tables are emitted and fully qualified (`verb_attempt` and `verb_claim`) and that no `__SYNAPSE_` placeholder survived - an unsubstituted `__SYNAPSE_CLAIM_TABLE__` would ship as a literal table NAME:
   ```bash
   grep -c '__SYNAPSE' install.sql          # must be 0
   grep -n 'verb_claim (' install.sql       # must be db.schema-qualified
   ```
7. Update the pinned commit and date in this file.

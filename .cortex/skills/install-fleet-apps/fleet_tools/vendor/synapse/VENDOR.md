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

Previously only the prebuilt `dist/` was vendored, with the patches applied directly
to emitted JavaScript. That made the local changes invisible to review and impossible
to diff against upstream. Vendoring source fixes both.

## Local patches (MUST survive every re-vendor)

Three deviations from upstream. Each is load-bearing: dropping one does not degrade
gracefully, it breaks a fresh install. The patch files in `patches/` are the record;
they are already applied to `src/` in this tree.

### 1. `COMMENT` before `EXECUTE AS` in generated procedure DDL

- File: `src/build/ddl.ts`
- Origin: repo commit `13943c91`
- Why: upstream emits `RETURNS OBJECT LANGUAGE JAVASCRIPT EXECUTE AS OWNER COMMENT=... AS`.
  Snowflake rejects `COMMENT` after `EXECUTE AS` with "unexpected COMMENT", which
  aborts `synapse deploy` for the whole bundle, so **no MCP servers get created** and
  the agent has no tools.

### 2. Tracking tags emitted by codegen, not hand-added to output

- Files: `src/build/ddl.ts` (per-procedure `COMMENT`), `src/ddl.ts` (`COMMENT` on the
  `VERB_ATTEMPT` hybrid table), `src/cli/materialize.ts` (`ALTER SESSION SET query_tag`
  in the `install.sql` preamble)
- Origin: repo commit `7c7db973`
- Why: AGENTS.md requires a `query_tag` on every session and a COMMENT tracking tag on
  every created object. The materialized `install.sql` is generated **and gitignored**,
  so the tags cannot be added to the output - they must come from the generator.
- Known exception: `CREATE MCP SERVER` has no `COMMENT` clause; it is tracked via its
  JSON-tagged parent schema.

### 3. `IDEMPOTENCY_KEY STRING DEFAULT NULL`

- File: `src/build/ddl.ts`
- Origin: repo commit `f23abece`
- Why: the Cortex Agent MCP server calls each verb with **named** arguments and omits
  the optional `idempotency_key`. Without a default, Snowflake raises "named arguments
  [...] do not match any signature" before the procedure body runs, so there is no
  `VERB_ATTEMPT` row and the agent surfaces a generic "Error parsing response" - every
  agent tool call fails even though the verb works when called directly.

## Re-vendoring procedure

1. Check whether upstream `packages/synapse` actually changed since the pinned SHA. If not, stop.
2. Copy `src/`, `tests/`, `tsconfig.json`, `vitest.config.ts`, `package.json`, `README.md` from the new commit.
3. Re-apply `patches/*.patch`. If a patch does not apply, reseat it by hand - upstream may have moved the code - and refresh the patch file.
4. `npm install && npm run build && npm test`.
5. Re-materialize and re-deploy the three bundles, then **recreate the agents** (`synapse deploy` does `CREATE OR REPLACE MCP SERVER`, so agents bound to the old server go stale).
6. Assert the generated `install.sql` still carries `query_tag`, per-procedure `COMMENT`, and `IDEMPOTENCY_KEY STRING DEFAULT NULL`.
7. Update the pinned commit and date in this file.

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

Two deviations from upstream, plus one new local file. Each is load-bearing: dropping
one does not degrade gracefully, it breaks a fresh install. `patches/*.patch` are the
replayable record and are already applied to this tree.

### patches/01-tracking-tags.patch

Files: new `src/tracking.ts`, `src/ddl.ts`, `src/build/ddl.ts`, `src/cli/materialize.ts`.
Origin: repo commits `7c7db973` and `13943c91`.

AGENTS.md requires a session `query_tag` on every session and a JSON `COMMENT`
tracking tag on every created object. The materialized `install.sql` is generated
**and gitignored**, so the tags cannot be added to the output - they must come from
the generator. `src/tracking.ts` holds the two literals so the three call sites
cannot drift:

- `src/ddl.ts` - `COMMENT` on the `VERB_ATTEMPT` hybrid table
- `src/build/ddl.ts` - `COMMENT` on each generated procedure
- `src/cli/materialize.ts` - `ALTER SESSION SET query_tag` in the `install.sql` preamble

**The procedure `COMMENT` must sit BEFORE `EXECUTE AS`.** Upstream emits
`... EXECUTE AS OWNER AS`; appending `COMMENT` after `EXECUTE AS` makes Snowflake
reject the statement with "unexpected COMMENT", which aborts `synapse deploy` for the
whole bundle, so **no MCP servers get created** and the agent silently has no tools.
Guarded by the `emits the tracking COMMENT before EXECUTE AS` test.

Known exception: `CREATE MCP SERVER` has no `COMMENT` clause; MCP servers are tracked
via their JSON-tagged parent schema.

### patches/02-test-fixtures.patch

Files: `tests/unit/ddl.test.ts`, `tests/unit/bundle.test.ts`.

Test-only. Two of these are **upstream bugs**, not our changes, and are candidates for
an upstream PR:

- `dc8827c3` gave `bundleProc` a required third `catalog` argument but did not update
  the fixtures, so all 7 bundle tests threw `Cannot read properties of undefined
  (reading 'database')`. A shared `CATALOG` const is now passed at each call site.
- The same commit changed the emitted arg to `IDEMPOTENCY_KEY STRING DEFAULT NULL` but
  left the assertion on the old `IDEMPOTENCY_KEY STRING)` form.

The third hunk is ours: the clause-order guard described above.

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
   git apply patches/01-tracking-tags.patch patches/02-test-fixtures.patch
   ```
   If a patch does not apply, reseat it by hand - upstream may have moved the code - then regenerate the patch file by diffing this tree against the fresh upstream copy.
4. `npm install && npm run build && npm test` (expect 66 passing).
5. Re-materialize and re-deploy the three bundles, then **recreate the agents** (`synapse deploy` does `CREATE OR REPLACE MCP SERVER`, so agents bound to the old server go stale).
6. Assert the generated `install.sql` still carries `query_tag`, per-procedure `COMMENT` positioned before `EXECUTE AS`, and `IDEMPOTENCY_KEY STRING DEFAULT NULL`.
7. Update the pinned commit and date in this file.

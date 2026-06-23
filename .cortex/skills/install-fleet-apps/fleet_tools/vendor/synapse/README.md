# @snowflake/synapse

A TypeScript framework for Snowflake apps. Author each procedure as a normal TS function — typed args, typed result, helpers imported across files. The audit/replay/error-handling envelope every proc shares is generated, not hand-written. The same source compiles to either:

- **`runtime: 'sproc'`** — `CREATE OR REPLACE PROCEDURE ... LANGUAGE JAVASCRIPT EXECUTE AS OWNER` running inside Snowflake.
- **`runtime: 'local'`** — a Node bundle that runs verbs client-side via `snowflake-sdk`.

Both targets share one envelope, one audit table, one error model. The framework also materializes a **Claude Code MCP plugin** per install, so an agent can call your verbs as typed tools without you writing any glue.

## How it fits together

### The verb

A verb is a TS file that exports a `defineProc(...)` call. Args, returns, refs, role grants, and the agent-facing description all live with the verb:

```ts
// apps/myapp/src/procs/widgets/get_widget.ts
import { defineProc, fail, t } from "@snowflake/synapse";
import { Tables } from "../../catalog.js";

export const get_widget = defineProc({
  name: "get_widget",
  description: "Look up one widget by id. Returns NOT_FOUND if missing.",
  roles: ["user", "viewer"],
  refs: {
    [Tables.widget]: ["select"],
  },
  args: {
    widget_id: t.uuid().describe("the widget id"),
  },
  returns: {
    id: t.string(),
    name: t.string(),
    color: t.enum(["red", "green", "blue"]),
  },
  execute: async (args, ctx) => {
    const r = await ctx.conn.execRow<{
      ID: string;
      NAME: string;
      COLOR: string;
    }>(`SELECT id, name, color FROM ${Tables.widget} WHERE id = ?`, [
      args.widget_id,
    ]);
    if (!r) fail("NOT_FOUND", `widget ${args.widget_id} not found`);
    return {
      id: r.ID,
      name: r.NAME,
      color: r.COLOR as "red" | "green" | "blue",
    };
  },
});
```

What you don't write: idempotency replay, audit-row insertion, identity capture, error→code translation, args parsing. Those come from the envelope around `execute()`.

### The CLI

`synapse` is a node binary published by the framework. It's app-aware: every subcommand resolves the app's `synapse.config.ts` by walking up from cwd unless `--config` is passed.

```
synapse materialize --account <name>      # generate apps/_installed/<account>/<app>/install.sql + runtime.js + MCP server
synapse deploy --account <name>           # snow sql -f against the materialized install.sql
synapse install:list                      # list every materialized install of this app
synapse install:diff --account <name>     # diff on-disk install.sql against current source
synapse test:e2e --account <name>         # vitest run --dir tests/e2e against the install (target picked from install.json)
```

### The install

`apps/_installed/<account>/<app>/install.json` is the single source of truth for _where_ an app is installed. It captures the runtime mode, target database/schema, the `snow` CLI connection name, and the logical→actual role mapping:

```json
{
  "app": "param-rollout",
  "account": "snowhouse",
  "runtime": "sproc",
  "warehouse": "SNOWHOUSE",
  "database": "TEMP",
  "schema": "PARAM_ROLLOUT_SYNAPSE_TKOJIMA",
  "snowCliConn": "snowhouse",
  "roles": {
    "owner": "ENGINEER",
    "admin": "ENGINEER",
    "user": "ENGINEER",
    "viewer": "ENGINEER"
  }
}
```

Auth is delegated to `~/.snowflake/connections.toml`. `snowCliConn` selects an entry from there; `database`/`schema`/`warehouse` override its defaults so one connection can host many app installs.

`materialize` writes alongside `install.json`:

- `install.sql` — schema → seed → procs (sproc mode) or audit-table only (local mode) → grants. Single file, deployed via `snow sql -f`.
- `runtime.js` — self-contained CommonJS bundle exposing each verb as a named export, plus `ensureConnection()` / `closeConnection()`. snowflake-sdk is the only peer dep.
- `server.js` + `.claude-plugin/plugin.json` — Claude Code MCP plugin. The install dir IS the plugin; `claude-plugin` enables one tool per verb with typed `inputSchema` lifted from the verb's `args`.

### The runtime modes

`sproc` and `local` share the framework envelope and the audit table; they differ only in _where_ `execute()` runs:

|                    | `runtime: 'sproc'`                              | `runtime: 'local'`                                                 |
| ------------------ | ----------------------------------------------- | ------------------------------------------------------------------ |
| Where verbs run    | inside Snowflake (`EXECUTE AS OWNER`)           | in the calling Node process                                        |
| `install.sql`      | schema + seed + `CREATE PROCEDURE` × N + grants | schema + seed + audit-table DDL + per-(role, table, access) grants |
| `runtime.js` calls | `CALL <verb>(?, ?, ...)`                        | `runEnvelope(...)` directly against `snowflake-sdk`                |
| Caller permissions | `USAGE` on each procedure                       | direct DML on the verbs' `refs` tables                             |
| Use when           | production, multi-tenant                        | local dev, scripted clients, faster iteration                      |

The same verb file produces both. The build emits sproc-safe JS for sproc mode (sandbox lints, `&&`/`||` rewriting, `__async` → generator driver, bind normalizer) and a normal Node bundle for local mode.

### The MCP plugin

After `synapse materialize`, the install directory is a complete Claude Code plugin. Wire it into `~/.claude/settings.json`:

```json
{
  "plugins": {
    "param-rollout-snowhouse": {
      "type": "local",
      "path": "/Volumes/code2/synapse/apps/_installed/snowhouse/param-rollout"
    }
  }
}
```

The plugin's `server.js` is a stdio MCP server that requires `runtime.js` and registers one tool per verb (`<app>__<verb>`) with `inputSchema` derived from the verb's `args`. Tool descriptions and per-arg descriptions come from `defineProc({description, ...})` and `t.X().describe(...)`.

## Authoring a new app

A new app is a directory under `apps/` with a `synapse.config.ts`, a `src/` tree, and `tests/`. The framework is opinionated about layout but flexible about content.

### 1. Scaffold

```
apps/myapp/
├── package.json              # depends on @snowflake/synapse: workspace:*
├── tsconfig.json
├── vitest.config.ts
├── synapse.config.ts         # tells the CLI where things live
├── src/
│   ├── catalog.ts            # const Tables / Views / AppIdColumn
│   ├── errors.ts             # app-specific Codes layered over framework Codes
│   ├── helpers/              # locks, config helpers, identity helpers, etc.
│   ├── procs/                # one file per verb; subdirs are organizational
│   ├── schema/*.sql          # CREATE TABLE / VIEW DDL, deploy-ordered (010_, 020_, ...)
│   ├── seed/*.sql            # static data (roles defaults, system_config defaults)
│   └── grants/*.sql          # hand-written GRANTs (synapse only emits proc/table grants)
└── tests/
    ├── unit/                 # vitest run --dir tests/unit
    └── e2e/                  # vitest run --dir tests/e2e (uses SYNAPSE_INSTALL)
```

Minimum `synapse.config.ts`:

```ts
import { defineSynapseApp } from "@snowflake/synapse/config";
import { Tables, AppIdColumn } from "./src/catalog.js";

export default defineSynapseApp({
  name: "myapp",
  audit: {
    table: Tables.verbAttempt,
    appIdField: AppIdColumn,
  },
  // procsDir/schemaDir/seedDir/grantsDir default to ./src/<name>; override only if you move them.
});
```

### 2. Author verbs

Drop a file under `src/procs/` that exports a `defineProc({...})`. There's no barrel — `discoverProcs` walks the tree at materialize time, dynamic-imports each file, and registers the export. The verb's filename and directory are organizational only; the verb's logical name comes from `defineProc({name})`.

A verb declares:

- `name` — used as the SQL procedure name in sproc mode and the runtime export name in local mode.
- `description` — surfaced as the MCP tool description. One to three sentences naming when to call and what failure modes to expect.
- `roles` — logical role names (`'admin'`, `'user'`, `'viewer'`, ...) that get `GRANT USAGE ON PROCEDURE` (sproc) or table-level grants (local). The mapping to actual Snowflake roles is per-install in `install.json`.
- `refs` — object→access map (`{ [Tables.X]: ['select', 'update'] }`). Only used in `local` runtime to synthesize per-role table grants. Informational in sproc mode (procs run AS OWNER).
- `args` and `returns` — schema records using the `t.X()` DSL (`t.string`, `t.uuid`, `t.boolean`, `t.number`, `t.array`, `t.object`, `t.enum`). Add `.describe('text')` to surface per-arg semantics into the MCP `inputSchema`. Add `.nullable()` to allow null/undefined.
- `execute(args, ctx)` — the body. `ctx` carries `conn` (the typed connector), `identity` (caller user/role), and `fail(code, message)` for typed errors.

The framework parses `args` against the schema before `execute` runs, captures identity, checks the idempotency-key replay window, runs `execute`, and writes a `verb_attempt` row with `outcome=ok|err`, `error_code`, `result_hash`. None of that is in your verb file.

### 3. Configure an install

For each Snowflake account you want to deploy to, create the install dir and `install.json`:

```bash
mkdir -p apps/_installed/<account>/myapp
cat > apps/_installed/<account>/myapp/install.json <<'JSON'
{
  "app": "myapp",
  "account": "<account>",
  "runtime": "sproc",
  "warehouse": "<WAREHOUSE>",
  "database": "<DATABASE>",
  "schema": "<SCHEMA>",
  "snowCliConn": "<connections.toml entry>",
  "roles": {
    "owner": "<role>",
    "admin": "<role>",
    "user":  "<role>",
    "viewer":"<role>"
  }
}
JSON
```

Every logical role referenced by any verb's `roles` field (or by hand-written `grants/*.sql` via `IDENTIFIER($<logical>_role)`) must have a binding in `roles`. The CLI errors at materialize time if any are missing.

### 4. Materialize, deploy, test

```bash
cd apps/myapp
pnpm exec synapse materialize --account <account>     # writes install.sql, runtime.js, server.js
pnpm exec synapse deploy --account <account>          # snow sql -f install.sql via snowCliConn
pnpm exec synapse test:e2e --account <account>        # runs tests/e2e/ against the deployed install
```

`materialize` is fully deterministic — re-running it on unchanged source produces a byte-identical `install.sql` (modulo the `materializedAt` field in `install.json`). Use `synapse install:diff --account <account>` to see what's drifted.

### 5. Wire the MCP plugin (optional but recommended)

After `materialize`, the install dir is a working Claude Code plugin. Add it to `~/.claude/settings.json`:

```json
{
  "plugins": {
    "myapp-<account>": {
      "type": "local",
      "path": "<repo-root>/apps/_installed/<account>/myapp"
    }
  }
}
```

Restart Claude Code; tools appear as `myapp__<verb>` with descriptions and typed inputs. Re-running `materialize` after editing verbs is enough to update the plugin — no plugin-side edits.

### 6. Test discipline

- **Unit tests** (`tests/unit/`) use the `mockConn` / `mockSink` helpers from `@snowflake/synapse/testing`. One test file per verb, mirroring `src/procs/`. Cover happy path + every error code the verb can fail with. No Snowflake required.
- **E2E tests** (`tests/e2e/`) hit a real install. They read `SYNAPSE_INSTALL` (set by `synapse test:e2e`) and `install.json`'s `runtime` (sproc or local). The same test file runs against either target.
- **Audit-faithfulness gate**: when adding a verb that mutates state, run the e2e against both `runtime: 'sproc'` and `runtime: 'local'` installs and assert the `verb_attempt` rows are byte-equivalent (modulo per-call UUIDs). The framework guarantees this; the test enforces it on your specific verb.

## Public surface

```ts
// Authoring verbs
import { defineProc, t, Codes, SynapseError, fail } from "@snowflake/synapse";

// Local-runtime client + connector + audit sink
import {
  createSynapseRuntime,
  createConn,
  createConnFromCli,
  defaultAuditSink,
  wireSprocClient,
  type Conn,
  type AuditSink,
  type Identity,
  type Runtime,
} from "@snowflake/synapse/runtime";

// Build helpers (used by `synapse materialize`; rarely imported by app code)
import {
  buildSprocs,
  buildGrants,
  buildLocalGrants,
  bundleProc,
  bundleRuntime,
  bundlePlugin,
  discoverProcs,
  readInstallConfig,
  writeInstallConfig,
  installRuntime,
  type InstallConfig,
  type InstallRuntime,
} from "@snowflake/synapse/build";

// Per-app config schema for synapse.config.ts
import {
  defineSynapseApp,
  type SynapseAppConfig,
} from "@snowflake/synapse/config";

// Mock conn + sink for unit tests
import { mockConn, mockSink, type MockMatch } from "@snowflake/synapse/testing";
```

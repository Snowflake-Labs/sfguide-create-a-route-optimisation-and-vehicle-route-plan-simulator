import * as fs from 'node:fs';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import type { ResolvedSynapseAppConfig } from '../config.js';
import { discoverProcs } from '../build/discover.js';
import { buildSprocs } from '../build/install-sql.js';
import { buildGrants } from '../build/grants.js';
import { buildLocalGrants } from '../build/local-grants.js';
import { bundleRuntime } from '../build/runtime-js.js';
import { bundlePlugin } from '../build/plugin.js';
import { buildMcpServerSql, resolveMcpServerName } from '../build/mcp-server-sql.js';
import { auditTableDDL } from '../ddl.js';
import { TRACKING_QUERY_TAG } from '../tracking.js';
import { readInstallConfig, installRuntime } from '../build/install.js';
import { resolveTargetDir, parseTargetFlags } from './target.js';

/**
 * Pick the role that `install.sql` runs as (`USE ROLE ...`), which therefore owns
 * the audit table, procedures, MCP server, and grants it creates.
 *
 * LOCAL PATCH (see ../../VENDOR.md): `deploy` was added as the highest-precedence
 * key. Upstream starts at `roles.admin`, on the assumption that the logical role
 * named `admin` is an installer-grade role. That does not hold here: our logical
 * role names are the CONSUMER app roles (`user` -> FLEET_APP_USER, `ops` ->
 * FLEET_APP_OPS, `admin` -> FLEET_APP_ADMIN, each declared by the verbs' own
 * `roles: [...]`). With one binding per bundle, upstream's chain resolves to that
 * consumer role for all three bundles - directly via `roles.admin` for the admin
 * bundle, and via the first-key fallback for user and ops. install.sql then does
 * `USE ROLE FLEET_APP_USER` and dies on `CREATE OR REPLACE HYBRID TABLE
 * verb_attempt` for want of CREATE HYBRID TABLE, before any procedure, the MCP
 * server, or any grant is created. The failure is total, not partial.
 *
 * `admin` cannot simply be rebound to an installer role, because the admin bundle's
 * verbs declare `roles: ['admin']` and `install.ts` requires every proc-referenced
 * logical role to be bound; rebinding it would also mis-target that bundle's
 * `GRANT USAGE ON PROCEDURE` at the installer role. Hence a dedicated `deploy` key,
 * which no verb can reference. The rest of the chain is preserved so an app that
 * does use `admin` as an installer role is unaffected.
 */
export function pickDeployRole(roles: Record<string, string>): string | undefined {
  return roles.deploy ?? roles.admin ?? roles.owner ?? Object.values(roles)[0];
}

/**
 * Materialize `apps/_installed/<account>/<app>/install.sql` for a given install.
 * Branches on `install.runtime`:
 *   - 'sproc': schema -> seed -> proc DDL (incl. audit table) -> hand grants
 *              -> synapse-emitted GRANT USAGE ON PROCEDURE block
 *   - 'local': schema -> seed -> audit-table DDL -> hand grants
 *              -> synapse-emitted per-(role, table, access) GRANT block
 *              (procs are not deployed; callers run them client-side)
 *
 *   synapse materialize --account <name>
 *   synapse materialize --install <path>
 */
export async function runMaterialize(app: ResolvedSynapseAppConfig, argv: string[]): Promise<void> {
  const flags = parseTargetFlags(argv);
  const targetDir = resolveTargetDir(app, flags);
  const cfg = readInstallConfig(targetDir);
  if (cfg.app !== app.name) {
    console.error(`install.json at ${targetDir}: app="${cfg.app}", expected "${app.name}"`);
    process.exit(2);
  }
  const runtime = installRuntime(cfg);

  const { procs, paths: procPaths } = await discoverProcs(app.procsDir);
  const procInputs = Object.entries(procs).map(([name, proc]) => ({
    proc,
    procModulePath: procPaths[name]!,
    exportName: name,
  }));

  // Generate runtime-appropriate proc/grant SQL into temp files.
  const procsSql = path.join(targetDir, '.synapse-procs.sql');
  const grantsSql = path.join(targetDir, '.synapse-grants.sql');
  let mcpServerSqlText: string | null = null;

  // Fully qualify the audit table AND set a default schema so sproc bodies
  // work under any caller session's USE context. Without this, a caller-rights
  // CALL from a session whose default schema isn't the app's data schema
  // fails on `VERB_ATTEMPT does not exist or not authorized` (and every
  // other unqualified table reference the verb body reaches).
  const qualifiedAudit = {
    ...app.audit,
    table: `${cfg.database}.${cfg.schema}.${app.audit.table}`,
  };

  if (runtime === 'sproc') {
    await buildSprocs({
      procs: procInputs,
      out: procsSql,
      audit: qualifiedAudit,
      catalog: { database: cfg.database, schema: cfg.schema },
    });
    mcpServerSqlText = buildMcpServerSql({
      procs: procInputs.map(p => p.proc),
      install: cfg,
      app: app.name,
    });
    await buildGrants({
      procs: procInputs.map(p => p.proc),
      out: grantsSql,
      auditTable: qualifiedAudit.table,
      mcpServerName: resolveMcpServerName({
        procs: procInputs.map(p => p.proc),
        install: cfg,
        app: app.name,
      }),
    });
  } else {
    // 'local': no proc DDL, just the audit-table DDL (procs running
    // client-side still write to verb_attempt). Per-role table grants
    // synthesized from each verb's `refs`.
    fs.writeFileSync(procsSql, auditTableDDL({
      table: app.audit.table,
      ...(app.audit.appIdField ? { appIdColumn: app.audit.appIdField } : {}),
      hybrid: true,
    }) + '\n', 'utf8');
    await buildLocalGrants({ procs: procInputs.map(p => p.proc), out: grantsSql });
  }

  // Validate every logical role referenced has a binding.
  const allText = [
    fs.readFileSync(procsSql, 'utf8'),
    ...sortedSql(app.grantsDir).map(f => fs.readFileSync(f, 'utf8')),
    fs.readFileSync(grantsSql, 'utf8'),
  ].join('\n');
  const referencedRoles = new Set<string>();
  for (const m of allText.matchAll(/IDENTIFIER\(\$([a-z_][a-z0-9_]*)_role\)/g)) {
    referencedRoles.add(m[1]!);
  }
  const missing = [...referencedRoles].filter(r => !cfg.roles[r]);
  if (missing.length > 0) {
    console.error(`install.json missing role bindings: ${missing.join(', ')}`);
    console.error(`add them to "roles" in ${path.join(targetDir, 'install.json')}`);
    process.exit(2);
  }

  // Assemble install.sql.
  const deployRole = pickDeployRole(cfg.roles);
  if (!deployRole) {
    console.error('install.json has no roles defined; cannot pick a deploy role');
    process.exit(2);
  }
  const preamble: string[] = [
    '-- Generated by `synapse materialize`. Do not edit.',
    `-- App:      ${cfg.app}`,
    `-- Account:  ${cfg.account}`,
    `-- Runtime:  ${runtime}`,
    `-- Target:   ${cfg.database}.${cfg.schema} via ${cfg.snowCliConn}`,
    '',
    // LOCAL PATCH (see ../../VENDOR.md): AGENTS.md requires a session query_tag on
    // every session. install.sql is generated and gitignored, so the tag has to be
    // emitted here rather than added to the file.
    `ALTER SESSION SET query_tag = '${TRACKING_QUERY_TAG}';`,
    '',
    // USE ROLE pins deploy to the logical `admin` role so tables/procs/grants
    // are owned by it, not whatever role happens to be the operator's default.
    `USE ROLE ${deployRole};`,
    `USE WAREHOUSE ${cfg.warehouse};`,
    // CREATE DATABASE/SCHEMA is wrapped so a deploy role without CREATE DATABASE
    // ON ACCOUNT / CREATE SCHEMA ON DATABASE can still proceed against an
    // already-existing target. Snowflake checks the privilege before IF NOT
    // EXISTS, so the bare form errors even when the object exists.
    `EXECUTE IMMEDIATE $$BEGIN CREATE DATABASE IF NOT EXISTS ${cfg.database}; EXCEPTION WHEN OTHER THEN NULL; END;$$;`,
    `USE DATABASE ${cfg.database};`,
    `EXECUTE IMMEDIATE $$BEGIN CREATE SCHEMA IF NOT EXISTS ${cfg.schema}; EXCEPTION WHEN OTHER THEN NULL; END;$$;`,
    `USE SCHEMA ${cfg.schema};`,
    '',
    `SET db = '${cfg.database}';`,
    `SET schema = '${cfg.schema}';`,
    `SET warehouse = '${cfg.warehouse}';`,
  ];
  for (const [logical, actual] of Object.entries(cfg.roles).sort(([a], [b]) => a.localeCompare(b))) {
    preamble.push(`SET ${logical}_role = '${actual}';`);
  }
  if (cfg.variables) {
    for (const [name, value] of Object.entries(cfg.variables).sort(([a], [b]) => a.localeCompare(b))) {
      const escaped = value.replaceAll("'", "''");
      preamble.push(`SET ${name} = '${escaped}';`);
    }
  }

  const parts: string[] = [preamble.join('\n')];
  const readPart = (file: string): string =>
    fs.readFileSync(file, 'utf8').replace(/\s+$/, '');

  for (const file of sortedSql(app.schemaDir)) parts.push(`-- ${path.relative(app.appRoot, file)}`, readPart(file));
  for (const file of sortedSql(app.seedDir))   parts.push(`-- ${path.relative(app.appRoot, file)}`, readPart(file));
  parts.push(readPart(procsSql));
  if (mcpServerSqlText !== null) {
    parts.push('-- Snowflake-managed MCP server (registers each proc as a GENERIC tool)');
    parts.push(mcpServerSqlText);
  }
  if (!cfg.skipGrants) {
    for (const file of sortedSql(app.grantsDir)) parts.push(`-- ${path.relative(app.appRoot, file)}`, readPart(file));
    parts.push(readPart(grantsSql));
  }

  const installSql = path.join(targetDir, 'install.sql');
  fs.writeFileSync(installSql, parts.join('\n\n') + '\n', 'utf8');

  fs.unlinkSync(procsSql);
  fs.unlinkSync(grantsSql);

  // Emit runtime.js alongside install.sql. Self-contained CommonJS bundle
  // that exposes named verb exports + ensureConnection/closeConnection.
  const runtimeJs = path.join(targetDir, 'runtime.js');
  await bundleRuntime({
    procs: Object.fromEntries(
      procInputs.map(p => [p.exportName, { proc: p.proc, modulePath: p.procModulePath }]),
    ),
    audit: app.audit,
    install: cfg,
    runtime,
    appRoot: app.appRoot,
    out: runtimeJs,
  });

  // Emit a tiny package.json so consumers can resolve runtime.js's peer
  // dep (snowflake-sdk) via a normal `pnpm install` in this directory.
  fs.writeFileSync(path.join(targetDir, 'package.json'), JSON.stringify({
    name: `${cfg.app}-${cfg.account}-runtime`,
    private: true,
    main: 'runtime.js',
    dependencies: {
      'snowflake-sdk': '^1.11.0',
    },
  }, null, 2) + '\n', 'utf8');

  // Emit a Claude plugin at the install root (or under install.pluginPath if
  // set): .claude-plugin/plugin.json points at ./server.js (the MCP stdio
  // server), which requires ./runtime.js (the verb runtime). Same shape for
  // sproc and local; runtime.js's internals differ per mode (CALL vs
  // in-process). By default the install dir IS the plugin (flat layout);
  // setting install.pluginPath nests the plugin under a subdir so synapse
  // artifacts (install.sql, runtime.js, server.js, package.json) sit
  // separately from what Claude Code loads.
  const pluginOut = path.join(targetDir, cfg.pluginPath ?? '.');
  await bundlePlugin({
    app,
    install: cfg,
    procs,
    out: pluginOut,
  });

  // Update install.json with materialization metadata.
  const gitSha = (() => {
    try {
      const r = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: app.appRoot, encoding: 'utf8' });
      return r.status === 0 ? r.stdout.trim() : null;
    } catch { return null; }
  })();
  cfg.materializedAt = new Date().toISOString();
  if (gitSha) cfg.materializedFrom = `git:${gitSha}`;
  fs.writeFileSync(path.join(targetDir, 'install.json'), JSON.stringify(cfg, null, 2) + '\n', 'utf8');

  const summary = runtime === 'sproc'
    ? `${procInputs.length} procs`
    : `${procInputs.length} verbs (no procs deployed; runtime=local)`;
  console.log(`materialized ${path.relative(process.cwd(), installSql)} (${summary})`);
  if (mcpServerSqlText !== null) {
    const serverName = resolveMcpServerName({
      procs: procInputs.map(p => p.proc),
      install: cfg,
      app: app.name,
    });
    console.log(`            mcp server ${cfg.database}.${cfg.schema}.${serverName} registered in install.sql`);
  }
  console.log(`materialized ${path.relative(process.cwd(), runtimeJs)}`);
  console.log(`materialized ${path.relative(process.cwd(), path.join(pluginOut, 'server.js'))}`);
  console.log(`materialized ${path.relative(process.cwd(), path.join(pluginOut, '.claude-plugin/plugin.json'))}`);
}

function sortedSql(dir: string | null): string[] {
  if (!dir || !fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter(f => f.endsWith('.sql')).sort()
    .map(f => path.join(dir, f));
}

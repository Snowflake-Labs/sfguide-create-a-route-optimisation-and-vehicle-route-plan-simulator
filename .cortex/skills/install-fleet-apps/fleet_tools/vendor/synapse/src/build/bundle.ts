import * as path from 'node:path';
import * as url from 'node:url';
import * as fs from 'node:fs';
import * as esbuild from 'esbuild';
import { parse as acornParse } from 'acorn';
import { generate as astringGenerate } from 'astring';
import type {
  Program, Node, VariableDeclaration, ArrowFunctionExpression,
  FunctionExpression, BlockStatement, CallExpression,
} from 'acorn';
import type { ProcDef } from '../defineProc.js';
import { argsCaptureSuffix } from './ddl.js';
import { N_HELPER_SOURCE } from './sync-driver.js';

/**
 * Bundle a `ProcDef` into a self-contained JS string suitable for a Snowflake
 * stored procedure body.
 *
 * Pipeline:
 *   1. Generate a synthetic entry that imports the verb + the framework's
 *      sproc-target runtime entry (`runProcSproc`).
 *   2. esbuild bundles, lowering async/await to generators + `__async` helper.
 *      A custom resolver plugin handles `@snowflake/synapse/...` specifiers
 *      so the bundler works regardless of where the proc module lives.
 *   3. AST pass: parse the bundle, locate the top-level `__async` helper
 *      declaration, replace its body with the synchronous generator driver.
 *      Verifies that EITHER no `__async(` invocations exist (no async source)
 *      OR the helper is found and replaced — never the silent middle case.
 *   4. Replace `__SYNAPSE_AUDIT_TABLE__` / `__SYNAPSE_APP_ID_FIELD__` placeholders.
 *   5. Inject `_n` and append the args-capture suffix that calls `__synapse.__synapseEntry`.
 *   6. Lint: no `require(`, no `process.env`, no `import.meta`, no top-level
 *      `import`, no top-level `await`.
 */

/** Audit-config substituted into the bundled body at build time. */
export interface AuditBundleConfig {
  /** Audit table name (e.g. 'verb_attempt'). */
  table: string;
  /** App-specific row-key column name (e.g. 'rollout_id'). Optional. */
  appIdField?: string;
}

/**
 * Deployment target metadata passed to the bundler so it can substitute
 * `__SYNAPSE_DATABASE__` / `__SYNAPSE_SCHEMA__` at compile time. The framework
 * uses these to fully qualify every `defineCatalog(...)` value inline, which
 * is how procs survive callers whose session schema differs from the app's.
 */
export interface CatalogBundleConfig {
  /** Fully-qualified database name for the install target. */
  database: string;
  /** Schema name for the install target. */
  schema: string;
}

/** A single proc to bundle: the registered ProcDef + where to find its source. */
export interface ProcBuildInput {
  /** The registered proc — used for the DDL signature. */
  proc: ProcDef<string, unknown, unknown>;
  /** Absolute path to the TS file that exports the proc. */
  procModulePath: string;
  /** Export name to import from `procModulePath`. Defaults to `proc.name`. */
  exportName?: string;
}

/** Build the synthetic entry source. */
function syntheticEntry(input: ProcBuildInput): string {
  const exportName = input.exportName ?? input.proc.name;
  return `
import { ${exportName} as __proc } from ${JSON.stringify(input.procModulePath)};
import { runProcSproc } from '@snowflake/synapse/runtime/sproc';

// Attach to globalThis instead of using \`export\` so the suffix can call it
// directly without going through esbuild's __toCommonJS wrapper (which uses
// non-enumerable getters that don't survive in Snowflake's sandbox V8).
globalThis.__synapseEntry = function (args, idemKey) {
  return runProcSproc(__proc, args, idemKey);
};
`;
}

/**
 * Resolve `@snowflake/synapse/...` bare specifiers to the framework's own
 * source/dist files. Works at test time (running against `src/`) and at
 * production time (running from `dist/`), because the resolution is relative
 * to *this file's* location.
 *
 *   src/build/bundle.ts  -> moduleRoot = src/  ->  src/runtime/sproc.ts
 *   dist/build/bundle.js -> moduleRoot = dist/ -> dist/runtime/sproc.js
 *
 * Without this plugin esbuild can't find `@snowflake/synapse/runtime/sproc`
 * unless the proc module's `node_modules` chain includes a workspace link —
 * which is true for the example app but not for ad-hoc test fixtures or
 * external consumers in unusual layouts.
 */
function frameworkResolverPlugin(): esbuild.Plugin {
  const here = path.dirname(url.fileURLToPath(import.meta.url));
  const moduleRoot = path.resolve(here, '..');

  const exportMap: Record<string, string> = {
    '@snowflake/synapse':               path.join(moduleRoot, 'index'),
    '@snowflake/synapse/runtime':       path.join(moduleRoot, 'runtime/index'),
    '@snowflake/synapse/runtime/sproc': path.join(moduleRoot, 'runtime/sproc'),
    '@snowflake/synapse/testing':       path.join(moduleRoot, 'testing/index'),
    '@snowflake/synapse/build':         path.join(moduleRoot, 'build/index'),
  };

  function resolveTo(spec: string): string | null {
    const base = exportMap[spec];
    if (!base) return null;
    for (const ext of ['.ts', '.js']) {
      const candidate = base + ext;
      if (fs.existsSync(candidate)) return candidate;
    }
    return null;
  }

  return {
    name: 'synapse-framework-resolver',
    setup(build) {
      build.onResolve({ filter: /^@snowflake\/synapse(\/.*)?$/ }, args => {
        const resolved = resolveTo(args.path);
        if (!resolved) return null;
        return { path: resolved };
      });
    },
  };
}

/**
 * The synchronous generator driver body that replaces esbuild's `__async`.
 *
 * Verified by probes (snowhouse, 2026-05-27):
 *   - Drives generators yielding sync values without touching Promises.
 *   - Errors caught by inner try/catch in the generator behave correctly.
 *   - Unhandled throws bubble out as Snowflake errors with the original
 *     message preserved.
 *
 * Returned as an AST so we can splice it directly into the helper's
 * declaration. astring will print it back to source verbatim.
 */
function syncDriverBody(): BlockStatement {
  const src = `(function(__this, __arguments, generator) {
  var gen = generator.apply(__this, __arguments);
  var step = gen.next();
  while (!step.done) {
    try { step = gen.next(step.value); }
    catch (e) { step = gen.throw(e); }
  }
  return step.value;
})`;
  const program = acornParse(src, { ecmaVersion: 2020 }) as unknown as Program;
  const expr = (program.body[0] as { expression: FunctionExpression }).expression;
  return expr.body;
}

/**
 * Finds and rewrites the `__async` helper declaration. Returns the rewritten
 * source.
 *
 * Throws if `__async(` invocations exist (proving the source had async/await)
 * but the helper itself isn't found in the expected shape.
 */
function rewriteAsyncHelper(bundled: string): string {
  const program = acornParse(bundled, {
    ecmaVersion: 2020,
    sourceType: 'script',
    allowReturnOutsideFunction: false,
    allowAwaitOutsideFunction: false,
  }) as unknown as Program;

  const newBody = syncDriverBody();
  let foundAndReplaced = false;

  // Walk the program looking for: var __async = (...) => { ... };
  // It's nested inside the IIFE: `var __synapse = (() => { ...inner... })();`
  const scan = (nodes: Node[]) => {
    for (const node of nodes) {
      if (node.type === 'VariableDeclaration') {
        const vd = node as VariableDeclaration;
        for (const decl of vd.declarations) {
          if (
            decl.id.type === 'Identifier' &&
            decl.id.name === '__async' &&
            decl.init &&
            (decl.init.type === 'ArrowFunctionExpression' ||
             decl.init.type === 'FunctionExpression')
          ) {
            const fn = decl.init as ArrowFunctionExpression | FunctionExpression;
            const paramNames = fn.params.map(p =>
              p.type === 'Identifier' ? p.name : '<non-ident>',
            );
            if (
              paramNames.length === 3 &&
              paramNames[0] === '__this' &&
              paramNames[1] === '__arguments' &&
              paramNames[2] === 'generator'
            ) {
              fn.body = newBody;
              foundAndReplaced = true;
            }
          }
        }
      }
    }
  };

  // Top-level scan.
  scan(program.body);

  // Descend into the IIFE: `var __synapse = (() => { ... })();`
  for (const stmt of program.body) {
    let init: Node | null = null;
    if (stmt.type === 'VariableDeclaration') {
      const decl = (stmt as VariableDeclaration).declarations[0];
      if (decl?.init) init = decl.init;
    }
    if (init && init.type === 'CallExpression') {
      const callee = (init as CallExpression).callee;
      if (callee.type === 'ArrowFunctionExpression' || callee.type === 'FunctionExpression') {
        const fnBody = (callee as ArrowFunctionExpression | FunctionExpression).body;
        if (fnBody.type === 'BlockStatement') {
          scan(fnBody.body);
        }
      }
    }
  }

  // Validation: if the source had async/await, esbuild emits `__async(this, null, function*() { ... })`
  // call sites. Search for those (in the printed output, since we're going to print anyway).
  // Pass 2: rewrite LogicalExpression (`&&`, `||`, `??`) to ConditionalExpression.
  // Snowflake's JS-proc V8 does NOT short-circuit `&&`/`||` reliably (verified
  // via probe, snowhouse 2026-05-27): `var x = undefined; x && y` evaluates `y`
  // and treats the operator as bitwise `&`. Ternaries DO short-circuit, so we
  // rewrite every logical expression to its ternary form:
  //   a && b   ->   a ? b : a
  //   a || b   ->   a ? a : b
  //   a ?? b   ->   a !== null && a !== undefined ? a : b   (recursively rewritten)
  // We walk the WHOLE AST including the outer IIFE body.
  rewriteLogicalExpressions(program);

  const printed = astringGenerate(program as unknown as Node);
  const hasAsyncInvocation = /\b__async\s*\(/.test(printed);
  if (hasAsyncInvocation && !foundAndReplaced) {
    throw new Error(
      'bundle: found __async(...) invocations but could not locate the __async helper ' +
      'declaration to swap. esbuild may have changed its lowering shape.',
    );
  }
  return printed;
}

/**
 * Walk the AST and rewrite every `LogicalExpression` (`&&`, `||`, `??`) into a
 * `ConditionalExpression`. Necessary because Snowflake's JS-proc V8 evaluates
 * both sides of `&&`/`||` regardless of the left operand's truthiness, then
 * combines them with bitwise semantics — different from standard JavaScript.
 *
 * Rewrites:
 *   `a && b`   -> `a ? b : a`
 *   `a || b`   -> `a ? a : b`
 *   `a ?? b`   -> `(a === null || a === undefined) ? b : a`
 *
 * Note: `a ?? b` is itself a logical expression; the rewrite produces an
 * intermediate logical expression for the null-check, which then gets rewritten
 * recursively. We work bottom-up by walking children before rewriting parents.
 *
 * Side effect: `a` is duplicated in the output (appears in both branches).
 * This is fine for pure expressions and the audit envelope's typical patterns
 * (property accesses, null checks). For impure subexpressions the rewrite would
 * call them twice — but the framework's source carefully avoids `a && b` where
 * `a` has side effects.
 */
function rewriteLogicalExpressions(program: Program): void {
  // Recursive walker: rewrites a node in place by mutating its parent's
  // reference. Returns the (possibly new) node.
  type AnyNode = Node & Record<string, unknown>;
  const visit = (node: AnyNode | null | undefined): AnyNode | null | undefined => {
    if (node === null || node === undefined) return node;
    if (typeof node !== 'object') return node;
    if (!node.type) return node;
    // Visit children first (post-order).
    for (const key of Object.keys(node)) {
      const child = (node as Record<string, unknown>)[key];
      if (Array.isArray(child)) {
        for (let i = 0; i < child.length; i++) {
          const c = child[i];
          if (c !== null && typeof c === 'object' && (c as { type?: unknown }).type) {
            child[i] = visit(c as AnyNode);
          }
        }
      } else if (child !== null && typeof child === 'object' && (child as { type?: unknown }).type) {
        (node as Record<string, unknown>)[key] = visit(child as AnyNode);
      }
    }
    // Now rewrite this node if it's a LogicalExpression.
    if (node.type !== 'LogicalExpression') return node;
    const op = node['operator'] as string;
    const left = node['left'] as AnyNode;
    const right = node['right'] as AnyNode;
    if (op === '&&') {
      // a && b -> a ? b : a
      // We need to clone `left` so the same node doesn't appear twice in the AST
      // (astring tolerates it, but mutations later would be unsafe).
      const leftClone = JSON.parse(JSON.stringify(left)) as AnyNode;
      return {
        type: 'ConditionalExpression',
        test: left,
        consequent: right,
        alternate: leftClone,
      } as unknown as AnyNode;
    }
    if (op === '||') {
      // a || b -> a ? a : b
      const leftClone = JSON.parse(JSON.stringify(left)) as AnyNode;
      return {
        type: 'ConditionalExpression',
        test: left,
        consequent: leftClone,
        alternate: right,
      } as unknown as AnyNode;
    }
    if (op === '??') {
      // a ?? b -> (a === null || a === undefined) ? b : a
      // Build the test as a BinaryExpression chain. Since we can't use `||`
      // here (the very thing we're avoiding), we lower further:
      //   (a === null) ? b : ((a === undefined) ? b : a)
      const aClone1 = JSON.parse(JSON.stringify(left)) as AnyNode;
      const aClone2 = JSON.parse(JSON.stringify(left)) as AnyNode;
      const aClone3 = JSON.parse(JSON.stringify(left)) as AnyNode;
      const bClone1 = JSON.parse(JSON.stringify(right)) as AnyNode;
      const undefinedExpr = { type: 'Identifier', name: 'undefined' } as unknown as AnyNode;
      const innerCond = {
        type: 'ConditionalExpression',
        test: {
          type: 'BinaryExpression',
          operator: '===',
          left: aClone1,
          right: undefinedExpr,
        },
        consequent: right,
        alternate: aClone2,
      } as unknown as AnyNode;
      return {
        type: 'ConditionalExpression',
        test: {
          type: 'BinaryExpression',
          operator: '===',
          left,
          right: { type: 'Literal', value: null, raw: 'null' },
        },
        consequent: bClone1,
        alternate: innerCond,
      } as unknown as AnyNode;
      void aClone3; // kept for potential debugging
    }
    return node;
  };
  visit(program as unknown as AnyNode);
}

/** Replace audit-config placeholders with the configured values. */
// LOCAL PATCH (see ../../VENDOR.md): qualify the audit table with the install
// target's database.schema.
//
// Apps declare `audit: { table: 'verb_attempt' }` in synapse.config.ts, which the
// CLI evaluates OUTSIDE a bundle - so `defineCatalog` cannot help there and the
// name arrives bare. The emitted proc body then does `INSERT INTO verb_attempt`,
// resolved against whatever schema the SESSION has when the verb is called. That
// is not the deploy-time schema: agent/MCP callers arrive with their own context.
// It happens to work today, but it is the exact failure mode `catalog.ts` was
// added upstream to remove, so close it for the audit path too: the bundler
// already knows the target, so qualify with it. Same table either way - strictly
// more robust when the caller's schema differs.
//
// An already-qualified name (contains a '.') is passed through untouched, and
// outside a target (unit tests, ad-hoc bundling) the bare name is preserved.
function injectAuditConfig(
  src: string,
  audit: AuditBundleConfig,
  catalog?: CatalogBundleConfig,
): string {
  const qualified =
    catalog?.database && catalog?.schema && !audit.table.includes('.')
      ? `${catalog.database}.${catalog.schema}.${audit.table}`
      : audit.table;
  let out = src.replace(/__SYNAPSE_AUDIT_TABLE__/g, qualified);
  out = out.replace(/__SYNAPSE_APP_ID_FIELD__/g, audit.appIdField ?? '');
  return out;
}

/** Throws if the bundle contains constructs the Snowflake JS sandbox rejects. */
function sandboxLint(src: string): void {
  const bareRequire = /(?<![A-Za-z_$.])require\s*\(/.exec(src);
  if (bareRequire) {
    throw new Error(`bundle contains bare require() at offset ${bareRequire.index}`);
  }
  if (src.includes('process.env')) {
    throw new Error('bundle contains process.env reference');
  }
  if (src.includes('import.meta')) {
    throw new Error('bundle contains import.meta reference');
  }
  if (/^\s*import\s+/m.test(src)) {
    throw new Error('bundle contains top-level import statement');
  }
  if (/^\s*await\s+/m.test(src)) {
    throw new Error('bundle contains top-level await');
  }
}

/** Bundle a single proc into a sproc-ready JS body string. */
export async function bundleProc(
  input: ProcBuildInput,
  audit: AuditBundleConfig,
  catalog: CatalogBundleConfig,
): Promise<string> {
  const entrySource = syntheticEntry(input);

  const result = await esbuild.build({
    stdin: {
      contents: entrySource,
      resolveDir: path.dirname(input.procModulePath),
      loader: 'ts',
    },
    bundle: true,
    format: 'iife',
    globalName: '__synapse',
    target: 'es2015',
    platform: 'neutral',
    treeShaking: true,
    write: false,
    legalComments: 'none',
    plugins: [frameworkResolverPlugin()],
    // Compile-time substitution so `defineCatalog({...})` in the app returns
    // fully-qualified strings baked into the emitted proc body.
    define: {
      __SYNAPSE_DATABASE__: JSON.stringify(catalog.database),
      __SYNAPSE_SCHEMA__: JSON.stringify(catalog.schema),
    },
  });

  let bundled = result.outputFiles[0]!.text;

  // 1. AST pass: swap __async for the synchronous driver.
  bundled = rewriteAsyncHelper(bundled);

  // 2. Replace audit-config placeholders.
  bundled = injectAuditConfig(bundled, audit, catalog);

  // 3. Inject _n at the top, append the args-capture suffix at the bottom.
  const prelude = `${N_HELPER_SOURCE}\n\n`;
  const suffix = `\n\n${argsCaptureSuffix(input.proc)}\n`;
  const body = `${prelude}${bundled}${suffix}`;

  // 4. Sandbox lint.
  sandboxLint(body);

  return body;
}

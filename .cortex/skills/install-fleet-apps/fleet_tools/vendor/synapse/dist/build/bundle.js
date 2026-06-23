import * as path from 'node:path';
import * as url from 'node:url';
import * as fs from 'node:fs';
import * as esbuild from 'esbuild';
import { parse as acornParse } from 'acorn';
import { generate as astringGenerate } from 'astring';
import { argsCaptureSuffix } from './ddl.js';
import { N_HELPER_SOURCE } from './sync-driver.js';
/** Build the synthetic entry source. */
function syntheticEntry(input) {
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
function frameworkResolverPlugin() {
    const here = path.dirname(url.fileURLToPath(import.meta.url));
    const moduleRoot = path.resolve(here, '..');
    const exportMap = {
        '@snowflake/synapse': path.join(moduleRoot, 'index'),
        '@snowflake/synapse/runtime': path.join(moduleRoot, 'runtime/index'),
        '@snowflake/synapse/runtime/sproc': path.join(moduleRoot, 'runtime/sproc'),
        '@snowflake/synapse/testing': path.join(moduleRoot, 'testing/index'),
        '@snowflake/synapse/build': path.join(moduleRoot, 'build/index'),
    };
    function resolveTo(spec) {
        const base = exportMap[spec];
        if (!base)
            return null;
        for (const ext of ['.ts', '.js']) {
            const candidate = base + ext;
            if (fs.existsSync(candidate))
                return candidate;
        }
        return null;
    }
    return {
        name: 'synapse-framework-resolver',
        setup(build) {
            build.onResolve({ filter: /^@snowflake\/synapse(\/.*)?$/ }, args => {
                const resolved = resolveTo(args.path);
                if (!resolved)
                    return null;
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
function syncDriverBody() {
    const src = `(function(__this, __arguments, generator) {
  var gen = generator.apply(__this, __arguments);
  var step = gen.next();
  while (!step.done) {
    try { step = gen.next(step.value); }
    catch (e) { step = gen.throw(e); }
  }
  return step.value;
})`;
    const program = acornParse(src, { ecmaVersion: 2020 });
    const expr = program.body[0].expression;
    return expr.body;
}
/**
 * Finds and rewrites the `__async` helper declaration. Returns the rewritten
 * source.
 *
 * Throws if `__async(` invocations exist (proving the source had async/await)
 * but the helper itself isn't found in the expected shape.
 */
function rewriteAsyncHelper(bundled) {
    const program = acornParse(bundled, {
        ecmaVersion: 2020,
        sourceType: 'script',
        allowReturnOutsideFunction: false,
        allowAwaitOutsideFunction: false,
    });
    const newBody = syncDriverBody();
    let foundAndReplaced = false;
    // Walk the program looking for: var __async = (...) => { ... };
    // It's nested inside the IIFE: `var __synapse = (() => { ...inner... })();`
    const scan = (nodes) => {
        for (const node of nodes) {
            if (node.type === 'VariableDeclaration') {
                const vd = node;
                for (const decl of vd.declarations) {
                    if (decl.id.type === 'Identifier' &&
                        decl.id.name === '__async' &&
                        decl.init &&
                        (decl.init.type === 'ArrowFunctionExpression' ||
                            decl.init.type === 'FunctionExpression')) {
                        const fn = decl.init;
                        const paramNames = fn.params.map(p => p.type === 'Identifier' ? p.name : '<non-ident>');
                        if (paramNames.length === 3 &&
                            paramNames[0] === '__this' &&
                            paramNames[1] === '__arguments' &&
                            paramNames[2] === 'generator') {
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
        let init = null;
        if (stmt.type === 'VariableDeclaration') {
            const decl = stmt.declarations[0];
            if (decl?.init)
                init = decl.init;
        }
        if (init && init.type === 'CallExpression') {
            const callee = init.callee;
            if (callee.type === 'ArrowFunctionExpression' || callee.type === 'FunctionExpression') {
                const fnBody = callee.body;
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
    const printed = astringGenerate(program);
    const hasAsyncInvocation = /\b__async\s*\(/.test(printed);
    if (hasAsyncInvocation && !foundAndReplaced) {
        throw new Error('bundle: found __async(...) invocations but could not locate the __async helper ' +
            'declaration to swap. esbuild may have changed its lowering shape.');
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
function rewriteLogicalExpressions(program) {
    const visit = (node) => {
        if (node === null || node === undefined)
            return node;
        if (typeof node !== 'object')
            return node;
        if (!node.type)
            return node;
        // Visit children first (post-order).
        for (const key of Object.keys(node)) {
            const child = node[key];
            if (Array.isArray(child)) {
                for (let i = 0; i < child.length; i++) {
                    const c = child[i];
                    if (c !== null && typeof c === 'object' && c.type) {
                        child[i] = visit(c);
                    }
                }
            }
            else if (child !== null && typeof child === 'object' && child.type) {
                node[key] = visit(child);
            }
        }
        // Now rewrite this node if it's a LogicalExpression.
        if (node.type !== 'LogicalExpression')
            return node;
        const op = node['operator'];
        const left = node['left'];
        const right = node['right'];
        if (op === '&&') {
            // a && b -> a ? b : a
            // We need to clone `left` so the same node doesn't appear twice in the AST
            // (astring tolerates it, but mutations later would be unsafe).
            const leftClone = JSON.parse(JSON.stringify(left));
            return {
                type: 'ConditionalExpression',
                test: left,
                consequent: right,
                alternate: leftClone,
            };
        }
        if (op === '||') {
            // a || b -> a ? a : b
            const leftClone = JSON.parse(JSON.stringify(left));
            return {
                type: 'ConditionalExpression',
                test: left,
                consequent: leftClone,
                alternate: right,
            };
        }
        if (op === '??') {
            // a ?? b -> (a === null || a === undefined) ? b : a
            // Build the test as a BinaryExpression chain. Since we can't use `||`
            // here (the very thing we're avoiding), we lower further:
            //   (a === null) ? b : ((a === undefined) ? b : a)
            const aClone1 = JSON.parse(JSON.stringify(left));
            const aClone2 = JSON.parse(JSON.stringify(left));
            const aClone3 = JSON.parse(JSON.stringify(left));
            const bClone1 = JSON.parse(JSON.stringify(right));
            const undefinedExpr = { type: 'Identifier', name: 'undefined' };
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
            };
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
            };
            void aClone3; // kept for potential debugging
        }
        return node;
    };
    visit(program);
}
/** Replace audit-config placeholders with the configured values. */
function injectAuditConfig(src, audit) {
    let out = src.replace(/__SYNAPSE_AUDIT_TABLE__/g, audit.table);
    out = out.replace(/__SYNAPSE_APP_ID_FIELD__/g, audit.appIdField ?? '');
    return out;
}
/** Throws if the bundle contains constructs the Snowflake JS sandbox rejects. */
function sandboxLint(src) {
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
export async function bundleProc(input, audit) {
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
    });
    let bundled = result.outputFiles[0].text;
    // 1. AST pass: swap __async for the synchronous driver.
    bundled = rewriteAsyncHelper(bundled);
    // 2. Replace audit-config placeholders.
    bundled = injectAuditConfig(bundled, audit);
    // 3. Inject _n at the top, append the args-capture suffix at the bottom.
    const prelude = `${N_HELPER_SOURCE}\n\n`;
    const suffix = `\n\n${argsCaptureSuffix(input.proc)}\n`;
    const body = `${prelude}${bundled}${suffix}`;
    // 4. Sandbox lint.
    sandboxLint(body);
    return body;
}
//# sourceMappingURL=bundle.js.map
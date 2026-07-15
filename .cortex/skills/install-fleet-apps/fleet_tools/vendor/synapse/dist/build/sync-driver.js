/**
 * Source of the synchronous generator driver injected into every emitted sproc
 * body.
 *
 * esbuild lowers `async`/`await` to a generator + `__async` helper when targeting
 * `es2015`. The default `__async` returns a Promise and drives the generator via
 * `Promise.resolve(x.value).then(...)` — which depends on V8 microtask queue
 * auto-flushing between turns. Verified via probe (snowhouse, 2026-05-27): the
 * Snowflake JS proc runtime does NOT auto-flush. The wrapped Promise stays
 * unresolved if read synchronously.
 *
 * Replace `__async`'s body with this driver: same signature, but drives the
 * generator synchronously and returns the value directly (not a Promise).
 * Works because every `await` in synapse's audit/envelope code yields over a
 * sync-resolving value (the sproc-target `Conn` returns rows directly, not
 * Promises).
 *
 * Verified end-to-end with the second probe: two `await`s, error throw inside
 * generator caught by inner try/catch, unhandled throw propagated as a
 * Snowflake error with the original message preserved.
 */
export const SYNC_ASYNC_HELPER = `var __async = function (__this, __arguments, generator) {
  var gen = generator.apply(__this, __arguments);
  var step = gen.next();
  while (!step.done) {
    try { step = gen.next(step.value); }
    catch (e) { step = gen.throw(e); }
  }
  return step.value;
};`;
/**
 * The `_n` bind normalizer. Inlined at the top of every emitted sproc body
 * (above the IIFE) so the sproc's `Conn` shim can apply it at every bind site.
 *
 * Rules (matching local-target `connector.ts:normalizeBinds`):
 *   undefined  -> null  (Snowflake's bind layer rejects undefined outright)
 *   Date       -> ISO string  (Date can't be bound directly)
 *   true/false -> 1/0  (Snowflake's stored-proc JS API rejects boolean binds
 *                       outright with "Unsupported type for binding argument";
 *                       NUMBER coerces to BOOLEAN at the column site)
 *   anything else passes through
 */
export const N_HELPER_SOURCE = `function _n(v) {
  if (v === undefined) return null;
  if (v === true) return 1;
  if (v === false) return 0;
  if (v instanceof Date) return v.toISOString();
  return v;
}`;
/**
 * Regex matching esbuild's emitted `__async` helper (es2015 target).
 *
 * esbuild emits the helper as a nested arrow function:
 *
 *   var __async = (__this, __arguments, generator) => {
 *     return new Promise((resolve, reject) => {
 *       var fulfilled = (value) => { ... };
 *       var rejected = (value) => { ... };
 *       var step = (x) => x.done ? resolve(x.value) : Promise.resolve(x.value).then(fulfilled, rejected);
 *       step((generator = generator.apply(__this, __arguments)).next());
 *     });
 *   };
 *
 * The regex anchors on the unique `step((generator = generator.apply(...))`
 * tail — that's distinctive enough to identify the helper while letting us
 * match through to the outer closing `};` reliably.
 */
export const ASYNC_HELPER_RE = /var __async = \(__this, __arguments, generator\) => \{[\s\S]*?step\(\(generator = generator\.apply\(__this, __arguments\)\)\.next\(\)\);\s*\}\);\s*\};/;
//# sourceMappingURL=sync-driver.js.map
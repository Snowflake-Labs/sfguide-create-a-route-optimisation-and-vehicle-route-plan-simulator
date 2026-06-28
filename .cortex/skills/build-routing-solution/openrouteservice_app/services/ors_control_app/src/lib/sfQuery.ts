// Consolidated Snowflake SQL helpers for the React control app.
//
// Two responsibilities:
//   1. `sfQuery` - POST a SQL string to /api/query (the Express read-only
//      passthrough that runs against Snowflake). Surfaces `body.error` when
//      callers opt in via `{throwOnError:true}`. Without this option callers
//      get an empty array even on SQL errors, which is how the entire repo
//      historically masked escape bugs.
//   2. `asSqlJsonLiteral` - embed a JS object into a SQL statement using a
//      Snowflake dollar-quoted string literal so that apostrophes, backslashes
//      and double-quotes in the JSON do NOT need to be escaped. Replaces the
//      fragile `'${JSON.stringify(x).replace(/'/g, "''")}'` pattern that breaks
//      whenever a free-text field contains a literal " or '.
//
// Single source of truth: `asset-velocity/helpers.ts` and
// `backload-matching/helpers.ts` re-export from here.

export interface SfQueryOpts {
  signal?: AbortSignal;
  /**
   * Throw on network error, abort, OR `body.error` (SQL error from /api/query)
   * instead of swallowing it and returning []. Set to true whenever the call
   * drives a user-visible button so the UI can surface the failure.
   */
  throwOnError?: boolean;
}

export async function sfQuery(
  sql: string,
  database = 'FLEET_INTELLIGENCE',
  schema = 'CORE',
  opts: SfQueryOpts = {},
): Promise<any[]> {
  try {
    const res = await fetch('/api/query', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sql, database, schema }),
      signal: opts.signal,
    });
    const rawText = await res.text();
    if (!res.ok) {
      const msg = `HTTP ${res.status}: ${rawText.slice(0, 200)}`;
      const err = new Error(msg);
      console.error('[sfQuery] HTTP error:', msg, 'SQL:', sql.slice(0, 300));
      if (opts.throwOnError) throw err;
      return [];
    }
    let body: unknown;
    try {
      body = rawText ? JSON.parse(rawText) : {};
    } catch {
      const msg = `Invalid JSON response: ${rawText.slice(0, 200)}`;
      const err = new Error(msg);
      console.error('[sfQuery] parse error:', msg, 'SQL:', sql.slice(0, 300));
      if (opts.throwOnError) throw err;
      return [];
    }
    // SQL errors come back as { error: "..." }. Without this branch, callers
    // see an empty array indistinguishable from "no rows" - the canonical
    // mask for JSON-escape bugs and silent permission errors.
    if (body && typeof body === 'object' && !Array.isArray(body) && 'error' in body) {
      const msg = String((body as { error?: unknown }).error ?? '').slice(0, 500);
      const err = new Error(`SQL: ${msg}`);
      console.error('[sfQuery] SQL error:', msg, 'SQL:', sql.slice(0, 300));
      if (opts.throwOnError) throw err;
      return [];
    }
    const rows = Array.isArray(body) ? body : ((body as { result?: unknown[] }).result ?? []);
    return Array.isArray(rows) ? rows : [];
  } catch (err: any) {
    if (err?.name === 'AbortError') {
      if (opts.throwOnError) throw err;
      return [];
    }
    // Network errors and any error rethrown above land here.
    console.error('[sfQuery] Error:', err?.message ?? err, 'SQL:', sql.slice(0, 300));
    if (opts.throwOnError) throw err;
    return [];
  }
}

/**
 * Embed `value` as a Snowflake plain dollar-quoted string literal (`$$...$$`).
 *
 * Why dollar-quoting: a single-quoted SQL literal forces the JSON payload to
 * survive TWO escape layers (SQL `''` doubling AND JSON `\"` escaping). When
 * a free-text field contains a literal `"` (e.g. terminal names exported with
 * surrounding quotes), the resulting `\"...\"` sequence inside a single-quoted
 * SQL string trips Snowflake's PARSE_JSON ("missing comma"). Dollar-quoted
 * literals pass their contents through verbatim, so PARSE_JSON sees the
 * original JSON.stringify output unchanged.
 *
 * Snowflake's dollar-quote syntax is plain `$$...$$` ONLY. Postgres-style
 * tagged delimiters (`$tag$...$tag$`) are NOT supported by Snowflake's parser
 * (and cause "syntax error ... unexpected '$'" via the REST SQL API).
 *
 * Collision safety: JSON.stringify never produces `$$` from typical data, but
 * a payload could in theory contain a literal `$$` (e.g. user-supplied text).
 * We replace every `$` in the serialised JSON with the JSON unicode escape
 * `\u0024`. The receiving JSON parser decodes `\u0024` back to `$`, so
 * semantics are preserved, but the Snowflake SQL lexer never sees a stray
 * `$` that could be mistaken for a dollar-quote terminator.
 */
export function asSqlJsonLiteral(value: unknown): string {
  // Replace `$` chars in the serialised JSON with the unicode escape \u0024.
  // The string is then dollar-quote-safe AND still semantically identical
  // after PARSE_JSON.
  const json = JSON.stringify(value).replace(/\$/g, '\\u0024');
  return `$$${json}$$`;
}

/**
 * Strip characters from free-text fields that are noisy or harmful when
 * embedded inside a JSON value (POI names, addresses, listing text). Use
 * this for `description` fields that are surfaced to the LLM or to debug
 * logs - the data layer (asSqlJsonLiteral) is already escape-proof, but
 * stripped strings keep diagnostics readable.
 */
export function safeText(s: string | null | undefined, maxLen = 80): string {
  return String(s ?? '')
    .replace(/["\\\n\r\t]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxLen);
}

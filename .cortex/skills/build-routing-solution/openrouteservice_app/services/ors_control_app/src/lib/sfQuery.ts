// Consolidated Snowflake SQL helpers for the React control app.
//
// Two responsibilities:
//   1. `sfQuery` — POST a SQL string to /api/query (the Express read-only
//      passthrough that runs against Snowflake). Surfaces `body.error` when
//      callers opt in via `{throwOnError:true}`. Without this option callers
//      get an empty array even on SQL errors, which is how the entire repo
//      historically masked escape bugs.
//   2. `asSqlJsonLiteral` — embed a JS object into a SQL statement using a
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
    const body = await res.json();
    // SQL errors come back as { error: "..." }. Without this branch, callers
    // see an empty array indistinguishable from "no rows" — the canonical
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
 * Embed `value` as a Snowflake dollar-quoted string literal.
 *
 * Example output for `{a: 'O\'Reilly', b: '"quoted"'}`:
 *
 *   $_SF_JSON_${"a":"O'Reilly","b":"\"quoted\""}$_SF_JSON_$
 *
 * Snowflake passes the contents of a dollar-quoted string verbatim to
 * downstream functions (PARSE_JSON, etc.) — there is no second layer of
 * SQL-string escaping to fight with, so the JSON payload's own escapes
 * (\", \\, \n, ...) get to PARSE_JSON unmodified.
 *
 * The collision check is purely defensive: realistic payloads never contain
 * the static delimiter, but we suffix it with a random tag if they do.
 */
export function asSqlJsonLiteral(value: unknown): string {
  const json = JSON.stringify(value);
  const STATIC = '$_SF_JSON_$';
  if (!json.includes(STATIC)) return `${STATIC}${json}${STATIC}`;
  // Vanishingly rare path. Generate a unique delimiter that is not present
  // in the payload.
  for (let i = 0; i < 8; i++) {
    const tag = `$_SF_JSON_${Math.random().toString(36).slice(2, 10).toUpperCase()}_$`;
    if (!json.includes(tag)) return `${tag}${json}${tag}`;
  }
  // Safety net: should be unreachable.
  throw new Error('asSqlJsonLiteral: could not pick a non-colliding delimiter');
}

/**
 * Strip characters from free-text fields that are noisy or harmful when
 * embedded inside a JSON value (POI names, addresses, listing text). Use
 * this for `description` fields that are surfaced to the LLM or to debug
 * logs — the data layer (asSqlJsonLiteral) is already escape-proof, but
 * stripped strings keep diagnostics readable.
 */
export function safeText(s: string | null | undefined, maxLen = 80): string {
  return String(s ?? '')
    .replace(/["\\\n\r\t]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxLen);
}

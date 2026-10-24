import type { ProcContext } from '@snowflake/synapse';

type Conn = ProcContext['conn'];

/**
 * CALL an existing routing procedure that returns a VARIANT, and normalize the
 * result to a plain object.
 *
 * `CALL proc(...)` yields a single-row, single-column result set whose column is
 * named after the procedure and whose value is the VARIANT. Depending on the
 * runtime the value arrives as an object or a JSON string; we parse strings and
 * wrap non-object values so the proc's `result` (t.object) always validates.
 */
export async function callTool(
  conn: Conn,
  fqProc: string,
  binds: (string | number | null)[],
): Promise<Record<string, unknown>> {
  const placeholders = binds.map(() => '?').join(', ');
  const row = await conn.execRow<Record<string, unknown>>(`CALL ${fqProc}(${placeholders})`, binds);
  if (!row) return { status: 'error', message: 'no result returned' };

  const raw = Object.values(row)[0];
  let value: unknown = raw;
  if (typeof raw === 'string') {
    try {
      value = JSON.parse(raw);
    } catch {
      value = { status: 'ok', value: raw };
    }
  }
  if (value === null || value === undefined) return { status: 'ok' };
  if (typeof value !== 'object' || Array.isArray(value)) {
    return { status: 'ok', value };
  }
  return value as Record<string, unknown>;
}

const SOLVE_RESULTS = 'FLEET_INTELLIGENCE.CORE.SOLVE_RESULTS';

/**
 * FNV-1a, without Math.imul.
 *
 * The shift-and-add form of the prime multiply is deliberate: a plain
 * `h * 16777619` exceeds 2^53 and silently loses precision, and `Math.imul` is
 * ES6 - safe in the app's bundle, but this file is compiled into a Snowflake
 * LANGUAGE JAVASCRIPT procedure whose runtime is not the app's. Nothing here
 * needs cryptographic strength; it only needs to be stable and well spread.
 */
function hash36(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = (h + (h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24)) >>> 0;
  }
  return h.toString(36);
}

/**
 * Record a completed solve so a UI can COLLECT it instead of solving again.
 *
 * WHY THIS EXISTS
 * ---------------
 * A solve reached through the app's `/api/tool` already lands in SOLVE_RESULTS,
 * because that route runs every verb through `runSolve`. A solve the AGENT runs
 * does not: the MCP server calls this procedure directly and the app is not in
 * the path at all. So the agent could produce a plan, describe it accurately,
 * and have no way to put it on screen except by asking the page to redo the same
 * 38-to-168 second job - and the second run is a DIFFERENT solve, so the numbers
 * on screen could disagree with the numbers just quoted in chat.
 *
 * THE KEY IS RETURNED, NEVER RECOMPUTED BY THE READER
 * The app has its own `solveKey()` (lib/solve-store.ts) over its own params
 * object. Agreeing with it from here would mean reimplementing the hash in a
 * second language AND matching that params object field for field, forever - and
 * a one-field drift does not fail, it just produces a different key, so
 * rehydration silently misses and the page quietly re-solves. Instead the key is
 * generated here and handed back in the verb result: the only contract is "a row
 * exists under the key I returned", which one query can check.
 *
 * The key is deterministic in the arguments, so an agent asked the same question
 * twice reuses one row rather than accumulating duplicates.
 *
 * BEST EFFORT, ALWAYS
 * Every failure is swallowed. On a fresh install the admin app's boot DDL may
 * not have created the table yet, and a solve that cannot be cached must still
 * be a solve that worked.
 */
export async function persistSolve(
  conn: Conn,
  verb: string,
  params: unknown,
  result: unknown,
): Promise<string | null> {
  const key = `${verb}_${hash36(`${verb}:${JSON.stringify(params ?? null)}`)}`;
  // Rows shape, not the bare object. The collector (/api/solve-status) unwraps
  // the first column of the first row exactly as the inline paths do, so a bare
  // object here would arrive as something the client cannot read - and it would
  // not throw, it would render an empty plan.
  const payload = JSON.stringify([{ RESULT: JSON.stringify(result ?? null) }]);
  const paramsJson = JSON.stringify(params ?? null);
  try {
    await conn.exec(
      `MERGE INTO ${SOLVE_RESULTS} t
         USING (SELECT ? AS SOLVE_KEY) s
         ON t.SOLVE_KEY = s.SOLVE_KEY
       WHEN MATCHED THEN UPDATE SET
         STATUS = 'SUCCESS', RESULT = PARSE_JSON(?), ERROR_MESSAGE = NULL,
         STATEMENT_HANDLE = NULL,
         SUBMITTED_AT = CURRENT_TIMESTAMP(), COMPLETED_AT = CURRENT_TIMESTAMP()
       WHEN NOT MATCHED THEN INSERT
         (SOLVE_KEY, VERB, STATEMENT_HANDLE, STATUS, ACTOR, PARAMS_JSON,
          SUBMITTED_AT, COMPLETED_AT, RESULT)
         VALUES (?, ?, NULL, 'SUCCESS', CURRENT_USER(), PARSE_JSON(?),
                 CURRENT_TIMESTAMP(), CURRENT_TIMESTAMP(), PARSE_JSON(?))`,
      [key, payload, key, verb, paramsJson, payload],
    );
    return key;
  } catch {
    // Degraded: the caller still gets its answer, just without a redraw handle.
    return null;
  }
}

/**
 * Which data layers a catalog view depends on are missing or empty, for the
 * caller's role. VIEW_CATALOG.REQUIRED_OBJECTS (build_view_catalog.py) holds a
 * probe spec per dependency - the same object the app's /api/pack-status
 * probes:
 *   rows:FQN      must exist AND return a row (an input layer left empty is
 *                 not built)
 *   exists:FQN    must only exist (a computed view where zero rows is a
 *                 legitimate answer)
 *   function:FQN  must exist as a function
 *
 * Two statements at most, whatever the number of views: one existence check
 * across INFORMATION_SCHEMA, then ONE UNION ALL row probe over only the
 * objects that exist - a missing object inside the probe would fail the whole
 * statement. FQNs are interpolated into a FROM, so each must be a plain
 * three-part identifier in an allowed database; anything else is ignored.
 *
 * Fails open (no gaps) when the catalog predates the column or a probe cannot
 * run, matching the verbs' "no catalog -> do not block" stance.
 */
const SPEC_RE = /^(rows|exists|function):([A-Z0-9_]+)\.([A-Z0-9_]+)\.([A-Z0-9_]+)$/;
const PROBE_DATABASES = new Set(['FLEET_APP', 'FLEET_INTELLIGENCE']);

export interface LayerGaps {
  missing: string[];
  empty: string[];
}

interface Spec {
  mode: 'rows' | 'exists' | 'function';
  db: string;
  schema: string;
  name: string;
  fqn: string;
}

function parseSpecs(raw: unknown): Spec[] {
  const out: Spec[] = [];
  for (const s of Array.isArray(raw) ? raw : []) {
    const m = SPEC_RE.exec(String(s));
    if (!m) continue;
    const [, mode, db, schema, name] = m;
    if (!mode || !db || !schema || !name || !PROBE_DATABASES.has(db)) continue;
    out.push({ mode: mode as Spec['mode'], db, schema, name, fqn: `${db}.${schema}.${name}` });
  }
  return out;
}

/** view_id -> its gaps, for every requested view. */
export async function layerGapsFor(conn: Conn, viewIds: string[]): Promise<Record<string, LayerGaps>> {
  const result: Record<string, LayerGaps> = {};
  if (!viewIds.length) return result;
  let specsByView: Record<string, Spec[]>;
  try {
    const rows = await conn.exec<{ VIEW_ID?: string; R?: string }>(
      `SELECT VIEW_ID, REQUIRED_OBJECTS::STRING AS R FROM FLEET_INTELLIGENCE.SEMANTIC.VIEW_CATALOG
        WHERE VIEW_ID IN (${viewIds.map(() => '?').join(', ')})`,
      viewIds,
    );
    specsByView = {};
    for (const r of rows) {
      specsByView[String(r.VIEW_ID)] = parseSpecs(r.R ? JSON.parse(String(r.R)) : []);
    }
  } catch {
    return result;
  }
  const all = new Map<string, Spec>();
  for (const specs of Object.values(specsByView)) for (const s of specs) all.set(`${s.mode}:${s.fqn}`, s);
  if (!all.size) return result;

  // 1. existence, one statement across the allowed databases
  const existing = new Set<string>();
  try {
    const parts: string[] = [];
    const binds: string[] = [];
    for (const db of PROBE_DATABASES) {
      const tbl = [...all.values()].filter((s) => s.db === db && s.mode !== 'function');
      const fn = [...all.values()].filter((s) => s.db === db && s.mode === 'function');
      if (tbl.length) {
        parts.push(`SELECT '${db}.' || TABLE_SCHEMA || '.' || TABLE_NAME AS F FROM ${db}.INFORMATION_SCHEMA.TABLES
                     WHERE TABLE_SCHEMA || '.' || TABLE_NAME IN (${tbl.map(() => '?').join(', ')})`);
        binds.push(...tbl.map((s) => `${s.schema}.${s.name}`));
      }
      if (fn.length) {
        parts.push(`SELECT '${db}.' || FUNCTION_SCHEMA || '.' || FUNCTION_NAME FROM ${db}.INFORMATION_SCHEMA.FUNCTIONS
                     WHERE FUNCTION_SCHEMA || '.' || FUNCTION_NAME IN (${fn.map(() => '?').join(', ')})`);
        binds.push(...fn.map((s) => `${s.schema}.${s.name}`));
      }
    }
    const rows = await conn.exec<{ F?: string }>(parts.join(' UNION ALL '), binds);
    for (const r of rows) existing.add(String(r.F));
  } catch {
    return result;
  }

  // 2. one row probe over the rows-mode objects that exist
  const empty = new Set<string>();
  const probe = [...new Set([...all.values()].filter((s) => s.mode === 'rows' && existing.has(s.fqn)).map((s) => s.fqn))];
  if (probe.length) {
    try {
      const rows = await conn.exec<{ O?: string; N?: number }>(
        probe.map((f) => `SELECT '${f}' AS O, COUNT(*) AS N FROM (SELECT 1 FROM ${f} LIMIT 1)`).join(' UNION ALL '),
      );
      for (const r of rows) if (Number(r.N ?? 0) === 0) empty.add(String(r.O));
    } catch {
      // Could not measure rows: report only what is known missing.
    }
  }

  for (const [vid, specs] of Object.entries(specsByView)) {
    result[vid] = {
      missing: [...new Set(specs.filter((s) => !existing.has(s.fqn)).map((s) => s.fqn))],
      empty: [...new Set(specs.filter((s) => s.mode === 'rows' && empty.has(s.fqn)).map((s) => s.fqn))],
    };
  }
  return result;
}

export function hasGaps(g: LayerGaps | undefined): g is LayerGaps {
  return !!g && (g.missing.length > 0 || g.empty.length > 0);
}

/** The caveat a verb passes on when the view it is about to hand over is dead. */
export function unavailableNote(label: string, g: LayerGaps): string {
  const parts: string[] = [];
  if (g.missing.length) parts.push(`never built (${g.missing.join(', ')} does not exist)`);
  if (g.empty.length) parts.push(`built but empty in this account (${g.empty.join(', ')} has no rows)`);
  return (
    `${label} is NOT usable in this deployment: its data layer is ${parts.join(' and ')}, so it ` +
    `opens to rebuild steps instead of results. Say so plainly and do not describe its results. ` +
    `An operator rebuilds it with scripts/validate_app_views.py -c <connection> --repair ` +
    `(for Location: CALL FLEET_INTELLIGENCE.LOCATION.BUILD_LOCATION_DIAGNOSTICS()). ` +
    `There is no dataset generator for it in the admin app.`
  );
}

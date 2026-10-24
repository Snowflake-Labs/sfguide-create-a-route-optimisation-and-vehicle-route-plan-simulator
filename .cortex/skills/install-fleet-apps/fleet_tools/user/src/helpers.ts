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
 * FLEET_APP schemas a catalog view reads that do not exist for the caller's
 * role. VIEW_CATALOG.REQUIRED_SCHEMAS (build_view_catalog.py) lists them; a
 * schema counts as present when INFORMATION_SCHEMA shows any table, view or
 * function in it. This catches a layer that was never built - a customer
 * install had no FLEET_APP.LOCATION at all, yet the agent offered Site Impact.
 * A layer that exists but is empty is caught by the app's own row probe
 * (/api/pack-status), which opens such a view to its rebuild steps.
 *
 * Fails open (returns []) on an older catalog without the column, matching the
 * verbs' existing "no catalog -> do not block" stance.
 */
export const MISSING_LAYERS_SQL =
  `SELECT COALESCE(ARRAY_AGG(f.VALUE::STRING), ARRAY_CONSTRUCT())::STRING
     FROM FLEET_INTELLIGENCE.SEMANTIC.VIEW_CATALOG c,
          LATERAL FLATTEN(INPUT => c.REQUIRED_SCHEMAS) f
    WHERE c.VIEW_ID = ?
      AND f.VALUE::STRING NOT IN (
            SELECT TABLE_SCHEMA FROM FLEET_APP.INFORMATION_SCHEMA.TABLES
            UNION ALL
            SELECT FUNCTION_SCHEMA FROM FLEET_APP.INFORMATION_SCHEMA.FUNCTIONS)`;

export async function missingLayers(conn: Conn, viewId: string): Promise<string[]> {
  try {
    const raw = await conn.execScalar<string>(MISSING_LAYERS_SQL, [viewId]);
    const parsed = raw == null ? [] : JSON.parse(String(raw));
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
  }
}

/** The caveat a verb passes on when the view it is about to hand over is dead. */
export function unavailableNote(label: string, layers: string[]): string {
  return (
    `${label} is NOT usable in this deployment: its data layer ` +
    `(FLEET_APP.${layers.join(', FLEET_APP.')}) was never built, so it opens to rebuild ` +
    `steps instead of results. Say so plainly and do not describe its results. ` +
    `An operator rebuilds it with scripts/validate_app_views.py -c <connection> --repair ` +
    `(for Location: CALL FLEET_INTELLIGENCE.LOCATION.BUILD_LOCATION_DIAGNOSTICS()). ` +
    `There is no dataset generator for it in the admin app.`
  );
}

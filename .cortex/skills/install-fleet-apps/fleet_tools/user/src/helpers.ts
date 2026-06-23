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

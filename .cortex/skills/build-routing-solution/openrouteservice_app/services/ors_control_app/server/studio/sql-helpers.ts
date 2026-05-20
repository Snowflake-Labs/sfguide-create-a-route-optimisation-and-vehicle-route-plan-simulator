// Pure SQL value formatting helpers used across studio code.
// Kept dependency-free so unit tests don't need a snowflake connection.

export const UNIFIED_DB = 'SYNTHETIC_DATASETS';
export const UNIFIED_SCHEMA = 'UNIFIED';

export function escVal(v: any): string {
  if (v === null || v === undefined) return 'NULL';
  if (typeof v === 'boolean') return v ? 'TRUE' : 'FALSE';
  if (typeof v === 'number') return String(v);
  if (v instanceof Date) return `TO_TIMESTAMP_NTZ('${v.toISOString()}', 'YYYY-MM-DD"T"HH24:MI:SS.FF3"Z"')`;
  const s = String(v).replace(/\\/g, '\\\\').replace(/'/g, "''").replace(/[\x00-\x1f]/g, '');
  return `'${s}'`;
}

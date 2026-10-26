// Regression test for helpers.ts layerGapsFor - the deep_link dependency probe.
//
// Run with: npx tsx verify_layer_gaps.mts   (from fleet_tools/user)
//
// WHAT THIS PROTECTS
//
// The existence probe is one UNION ALL over INFORMATION_SCHEMA.TABLES and
// .FUNCTIONS. A UNION takes its column name from the FIRST branch, and only the
// table branch was aliased AS F. A view whose only requirement is a function
// (space_time_density, fleetops_origins) produced a function-first UNION, the
// column came back unnamed, r.F was undefined, and the view was reported
// "never built". The agent then told a customer on a fully working install
// that Space-Time Density "is not available in this deployment".
//
// The mock connection names the result column the way Snowflake does: the
// FIRST branch's alias, or the raw expression text when it has none.
import { layerGapsFor } from './src/helpers';

let fails = 0;
function chk(label: string, ok: boolean) {
  if (!ok) { fails++; console.log(`FAIL  ${label}`); } else { console.log(`ok    ${label}`); }
}

const CATALOG: Record<string, string[]> = {
  space_time_density: ['function:FLEET_APP.UNIFIED_FLEET.F_VW_FACT_TRIPS_SCOPED'],
  mixed: ['rows:FLEET_APP.FLEET_OPS.VW_TRIPS', 'function:FLEET_APP.FLEET_OPS.F_TOP'],
  gone: ['function:FLEET_APP.FLEET_OPS.F_DROPPED'],
};
const EXISTING = new Set([
  'FLEET_APP.UNIFIED_FLEET.F_VW_FACT_TRIPS_SCOPED',
  'FLEET_APP.FLEET_OPS.VW_TRIPS',
  'FLEET_APP.FLEET_OPS.F_TOP',
]);

const conn = {
  async exec(sql: string, binds: string[] = []) {
    if (sql.includes('VIEW_CATALOG')) {
      return binds.filter((v) => CATALOG[v]).map((v) => ({ VIEW_ID: v, R: JSON.stringify(CATALOG[v]) }));
    }
    if (sql.includes('INFORMATION_SCHEMA')) {
      const first = sql.split('UNION ALL')[0] ?? '';
      const m = /^\s*SELECT\s+([\s\S]*?)\s+FROM\s/i.exec(first);
      const sel = (m?.[1] ?? '').trim();
      const alias = /\sAS\s+([A-Z_]+)$/i.exec(sel);
      const col = alias ? alias[1]!.toUpperCase() : sel.toUpperCase();
      const dbs = [...sql.matchAll(/SELECT '([A-Z_]+)\.'/g)].map((x) => x[1]);
      const out: Record<string, string>[] = [];
      for (const b of binds) {
        for (const db of new Set(dbs)) {
          const f = `${db}.${b}`;
          if (EXISTING.has(f)) out.push({ [col]: f });
        }
      }
      return out;
    }
    if (sql.includes('COUNT(*)')) {
      return [...sql.matchAll(/SELECT '([A-Z0-9_.]+)' AS O/g)].map((x) => ({ O: x[1], N: 1 }));
    }
    return [];
  },
};

// deep_link probes ONE view: a function-only view alone makes the UNION
// function-first, which is the shape that lost its column name.
const solo = await layerGapsFor(conn as never, ['space_time_density']);
const g = await layerGapsFor(conn as never, ['mixed', 'gone']);
chk('function-only view that exists -> no gaps',
  (solo.space_time_density?.missing.length ?? -1) === 0 && (solo.space_time_density?.empty.length ?? -1) === 0);
chk('mixed table+function view that exists -> no gaps',
  (g.mixed?.missing.length ?? -1) === 0);
chk('function-only view whose function is absent -> reported missing',
  JSON.stringify(g.gone?.missing) === JSON.stringify(['FLEET_APP.FLEET_OPS.F_DROPPED']));

console.log(fails ? `verify_layer_gaps: ${fails} FAILED` : 'verify_layer_gaps: all passed');
process.exit(fails ? 1 : 0);

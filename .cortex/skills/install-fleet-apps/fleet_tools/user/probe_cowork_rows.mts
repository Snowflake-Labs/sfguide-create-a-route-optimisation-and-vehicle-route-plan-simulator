// Live check for the CoWork `rows` projection on every geometry verb.
//
// Run with: npx tsx probe_cowork_rows.mts <connection>   (from fleet_tools/user)
//
// Calls each verb's REAL execute() against the named connection (the TOOL_*
// procedures already deployed there - nothing is created or changed), and
// asserts, per verb:
//   * `result` is exactly what the TOOL_* CALL inside that same verb returned,
//   * on SUCCESS with geometry: top-level `rows` of ONE shape (GEOJSON, or
//     LON+LAT), each cell under 64 KB and the array under 200 KB,
//   * on FAILED: no `rows` key at all.
import { connect } from './cowork_rows_conn.mts';
import { Procs } from './src/catalog.js';

type Obj = Record<string, unknown>;
type Verb = { execute: (a: Obj, x: never) => Promise<Obj> };
async function verb(name: string): Promise<Verb> {
  return ((await import(`./src/procs/${name}.js`)) as Record<string, Verb>)[name]!;
}

const base = await connect(process.argv[2] ?? 'fleet_test_evals');
// Spy: keep a deep copy of the VARIANT each `CALL FLEET_INTELLIGENCE...TOOL_*`
// returned, parsed the same way callTool parses it.
const lastCall: { value: unknown } = { value: undefined };
const conn = {
  ...base,
  execRow: async (s: string, b?: unknown[]) => {
    const row = await base.execRow(s, b);
    if (/^CALL FLEET_INTELLIGENCE\.ROUTING_TOOLS\.TOOL_/.test(s) && row) {
      const v = Object.values(row)[0];
      lastCall.value = JSON.parse(typeof v === 'string' ? v : JSON.stringify(v));
    }
    return row;
  },
};
const ctx = { conn } as never;

const vrp = JSON.stringify({
  vehicles: [{ id: 1, profile: 'driving-car', start: [-122.3937, 37.7955], end: [-122.3937, 37.7955] }],
  jobs: [
    { id: 1, location: [-122.4194, 37.7749] },
    { id: 2, location: [-122.4477, 37.7694] },
    { id: 3, location: [-122.4058, 37.8024] },
  ],
});

const cases: { verb: string; args: Obj; raw: [string, unknown[]]; expectFail?: boolean }[] = [
  { verb: 'get_directions', args: { locations_description: 'Ferry Building, San Francisco to Golden Gate Park, San Francisco', profile: null, region: null },
    raw: [Procs.directions, ['Ferry Building, San Francisco to Golden Gate Park, San Francisco', null, null]] },
  { verb: 'get_directions', args: { locations_description: 'Ferry Building, San Francisco to Times Square, New York', profile: null, region: null },
    raw: [Procs.directions, ['Ferry Building, San Francisco to Times Square, New York', null, null]], expectFail: true },
  { verb: 'compute_isochrone', args: { location_description: 'Ferry Building, San Francisco', range_minutes: 10, profile: null },
    raw: [Procs.isochrone, ['Ferry Building, San Francisco', 10, null]] },
  { verb: 'map_match', args: { locations_description: '37.7955,-122.3937 then 37.7937,-122.3965 then 37.7908,-122.4011 then 37.7880,-122.4045', profile: null },
    raw: [Procs.match, ['37.7955,-122.3937 then 37.7937,-122.3965 then 37.7908,-122.4011 then 37.7880,-122.4045', null]] },
  { verb: 'snap_to_road', args: { locations_description: '37.7955,-122.3937; 37.7749,-122.4194; 37.8080,-122.4400', radius_meters: null, profile: null },
    raw: [Procs.snap, ['37.7955,-122.3937; 37.7749,-122.4194; 37.8080,-122.4400', null, null]] },
  { verb: 'find_poi', args: { location_description: 'Ferry Building, San Francisco', range_minutes: 10, poi_category: 'restaurant', profile: null, max_results: null },
    raw: [Procs.poiInIsochrone, ['Ferry Building, San Francisco', 10, 'restaurant', null, null]] },
  { verb: 'catchment', args: { site_description: 'Ferry Building, San Francisco', range_minutes: 15, profile: null },
    raw: [Procs.catchment, ['Ferry Building, San Francisco', 15, null]] },
  { verb: 'optimize_routes', args: { delivery_locations: 'Union Square, Mission Dolores Park, Coit Tower, Alamo Square in San Francisco', depot_location: 'Ferry Building, San Francisco', num_vehicles: 2, profile: null, region: null },
    raw: [Procs.optimization, ['Union Square, Mission Dolores Park, Coit Tower, Alamo Square in San Francisco', 'Ferry Building, San Francisco', 2, null, null]] },
  { verb: 'delivery_optimization', args: { profile: null, region: null }, raw: [Procs.deliveryOptimization, [null, null]] },
  { verb: 'network_optimization', args: { profile: null, region: null }, raw: [Procs.networkOptimization, [null, null]] },
  { verb: 'evac_seed', args: { region: 'SanFrancisco', hazard_type: null, range_minutes: null, target_count: null },
    raw: [Procs.evacSeed, ['SanFrancisco', null, null, null]] },
  { verb: 'evac_solve', args: { challenge: vrp, region: 'SanFrancisco' }, raw: [Procs.evacSolve, [vrp, 'SanFrancisco']] },
  { verb: 'vrp_solve', args: { challenge: vrp, region: 'SanFrancisco' }, raw: [Procs.vrpSolve, [vrp, 'SanFrancisco']] },
  { verb: 'query_overture_places', args: { region: 'SanFrancisco', poi_category: 'restaurant', group_by: null, max_results: 500, min_lon: null, min_lat: null, max_lon: null, max_lat: null },
    raw: [Procs.overtureSearch, ['SanFrancisco', 'restaurant', null, 500, null, null, null, null]] },
  { verb: 'query_overture_addresses', args: { region: 'SanFrancisco', group_by: 'list', max_results: 3000, min_lon: null, min_lat: null, max_lon: null, max_lat: null },
    raw: [Procs.overtureAddresses, ['SanFrancisco', 'list', 3000, null, null, null, null]] },
];

let bad = 0;
for (const c of cases) {
  const label = `${c.verb}${c.expectFail ? ' (expect FAILED)' : ''}`;
  try {
    const out = (await (await verb(c.verb)).execute(c.args, ctx)) as Obj;
    const result = out.result as Obj;
    const status = String(result?.status ?? '');
    const notes: string[] = [];
    if (status !== 'SUCCESS') {
      if ('rows' in out) notes.push('FAILED payload carries rows');
      if (!c.expectFail) notes.push(`status=${status}: ${String(result?.error ?? result?.message ?? '').slice(0, 140)}`);
    } else {
      // Same-call comparison: the CALL row this verb itself received, captured
      // by the spy below. A second CALL is not comparable (AI geocoding and
      // VROOM are nondeterministic).
      const rawResult = lastCall.value;
      const same = JSON.stringify(rawResult) === JSON.stringify(result);
      if (!same) notes.push('result differs from what the TOOL_* CALL returned');
      const rows = out.rows as Obj[] | undefined;
      if (!rows) notes.push('SUCCESS without rows');
      else {
        const geo = rows.every((r) => 'GEOJSON' in r && Object.keys(r).length === 1);
        const pts = rows.every((r) => 'LON' in r && 'LAT' in r && Object.keys(r).length === 2);
        if (!geo && !pts) notes.push('rows mix shapes or carry other keys');
        const maxCell = Math.max(...rows.map((r) => JSON.stringify(r).length));
        const total = JSON.stringify(rows).length;
        if (maxCell >= 64_000) notes.push(`cell ${maxCell} B >= 64 KB`);
        if (total >= 200_000) notes.push(`rows ${total} B >= 200 KB`);
        const types = geo ? [...new Set(rows.map((r) => String((r.GEOJSON as Obj).type)))].join('/') : 'LON/LAT';
        console.log(`       ${rows.length} rows, ${types}, max cell ${maxCell} B, total ${total} B`);
      }
      // TOOL_OVERTURE_* already carry their own `rows` (the place list) inside
      // result; what must never happen is OUR map rows landing there.
      const inner = Array.isArray(result.rows) ? (result.rows as Obj[])[0] : undefined;
      if (inner && ('GEOJSON' in inner || ('LON' in inner && 'LAT' in inner))) notes.push('map rows nested in result');
    }
    const ok = notes.length === 0 || (c.expectFail && status !== 'SUCCESS' && !('rows' in out));
    if (!ok) bad++;
    console.log(`${ok ? 'ok  ' : 'FAIL'} ${label} [${status}] ${notes.join('; ')}`);
  } catch (e) {
    bad++;
    console.log(`FAIL ${label} threw: ${(e as Error).message.slice(0, 200)}`);
  }
}
console.log(bad ? `${bad} problem(s)` : 'all verbs OK');
process.exit(bad ? 1 : 0);

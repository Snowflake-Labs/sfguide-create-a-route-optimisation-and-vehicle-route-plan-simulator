// Stress the rows projection with real, very large polygons (read-only).
// Run with: npx tsx probe_cowork_rows_large.mts <connection>   (from fleet_tools/user)
import { withMapRows } from './src/map_rows.js';
import { geometryAt } from './src/map_rows.js';

import { connect } from './cowork_rows_conn.mts';
const conn = await connect(process.argv[2] ?? 'fleet_test_evals');
const rows = (await conn.exec(
  `SELECT REGION_KEY, ST_ASGEOJSON(BOUNDARY)::STRING AS G FROM OPENROUTESERVICE_APP.CORE.REGION_CATALOG
     WHERE BOUNDARY IS NOT NULL ORDER BY LENGTH(ST_ASGEOJSON(BOUNDARY)::STRING) DESC LIMIT 8`,
)) as { REGION_KEY: string; G: string }[];
const fc = { type: 'FeatureCollection', features: rows.map((r) => ({ type: 'Feature', geometry: JSON.parse(r.G), properties: {} })) };
const inBytes = rows.map((r) => r.G.length);
const result = { status: 'SUCCESS', geometry: fc };
const before = JSON.stringify(result);
const out = await withMapRows(conn as never, result, geometryAt('geometry'));
const cells = (out.rows ?? []).map((r) => JSON.stringify(r).length);
console.log('input cells (B):', inBytes.join(', '));
console.log('output cells (B):', cells.join(', '));
console.log('rows:', cells.length, 'total B:', JSON.stringify(out.rows ?? []).length);
console.log('result untouched:', JSON.stringify(out.result) === before);
const fail = await withMapRows(conn as never, { status: 'FAILED', geometry: fc }, geometryAt('geometry'));
console.log('FAILED has rows key:', 'rows' in fail);
const ok = cells.length > 0 && Math.max(...cells) < 64_000 && JSON.stringify(out.rows).length < 200_000 && !('rows' in fail);
console.log(ok ? 'OK' : 'FAIL');
conn.close();
process.exit(ok ? 0 : 1);

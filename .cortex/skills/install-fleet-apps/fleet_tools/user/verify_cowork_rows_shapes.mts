// Offline: the extractor handles every geometry shape the TOOL_* procs return.
// Run with: npx tsx verify_cowork_rows_shapes.mts   (from fleet_tools/user)
import { collectGeometries, pointRows, routeGeometries, snappedPoints, featurePoints, sqlMapRows, escapedLen } from './src/map_rows.js';

let bad = 0;
const eq = (name: string, got: unknown, want: unknown) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) bad++;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${ok ? '' : `\n     got  ${JSON.stringify(got)}\n     want ${JSON.stringify(want)}`}`);
};
const line = { type: 'LineString', coordinates: [[-122.4, 37.8], [-122.41, 37.79]] };
const poly = { type: 'Polygon', coordinates: [[[0, 0], [1, 0], [1, 1], [0, 0]]] };

eq('directions/isochrone: bare geometry', collectGeometries(line), [line]);
eq('ST_ASGEOJSON string (delivery/network/catchment)', collectGeometries(JSON.stringify(poly)), [poly]);
eq('FeatureCollection exploded, points dropped (evac/vrp)', collectGeometries({
  type: 'FeatureCollection',
  features: [{ type: 'Feature', geometry: line }, { type: 'Feature', geometry: { type: 'Point', coordinates: [1, 2] } },
             { type: 'Feature', geometry: poly }],
}), [line, poly]);
eq('GeometryCollection', collectGeometries({ type: 'GeometryCollection', geometries: [line, poly] }), [line, poly]);
// Google polyline "_p~iF~ps|U_ulLnnqC_mqNvxq`@" = (38.5,-120.2),(40.7,-120.95),(43.252,-126.453)
eq('encoded polyline (VROOM route geometry)', collectGeometries('_p~iF~ps|U_ulLnnqC_mqNvxq`@'),
   [{ type: 'LineString', coordinates: [[-120.2, 38.5], [-120.95, 40.7], [-126.453, 43.252]] }]);
eq('coordinate array (network route.geometry)', collectGeometries([[1, 2], [3, 4]]),
   [{ type: 'LineString', coordinates: [[1, 2], [3, 4]] }]);
eq('route without geometry skipped', collectGeometries(routeGeometries.pick({ routes: [{ geometry: line }, {}, { geometry: [] }] })), [line]);
eq('null / empty', collectGeometries(null), []);
eq('snap: unsnapped omitted', pointRows((snappedPoints.pick({ points: [
  { snapped_lon: -122.4, snapped_lat: 37.8 }, { snapped_lon: null, snapped_lat: null }] }) as never)),
   [{ LON: -122.4, LAT: 37.8 }]);
eq('overture features -> LON/LAT', pointRows(featurePoints.pick({ geometry: { type: 'FeatureCollection', features: [
  { type: 'Feature', geometry: { type: 'Point', coordinates: [-122.1, 37.1] } }] } }) as never),
   [{ LON: -122.1, LAT: 37.1 }]);
const many = Array.from({ length: 5000 }, (_, i) => ({ lon: -122 - i / 1e4, lat: 37 + i / 1e4 }));
const capped = pointRows(many);
eq('point cap holds row count <= 2000', capped.length <= 2000, true);
eq('point cap holds bytes < 200 KB', JSON.stringify(capped).length < 200_000, true);

// run_sql rows: the shape is read off the column names (snowflake-sdk returns UPPERCASE keys).
eq('run_sql H3 density -> H3 + VALUE', sqlMapRows([
  { H3_CELL: '881fb46625fffff', RESTAURANT_COUNT: 42 }, { H3_CELL: '881FB46627FFFFF', RESTAURANT_COUNT: 7 }]),
  [{ H3: '881fb46625fffff', VALUE: 42 }, { H3: '881fb46627fffff', VALUE: 7 }]);
eq('run_sql H3 INT column is not drawn (64-bit precision lost in JS)', sqlMapRows([{ H3: 613196571542028287, N: 1 }]), []);
eq('run_sql LAT/LON + label', sqlMapRows([{ NAME: 'Cafe', LATITUDE: 48.85, LONGITUDE: 2.29, RATING: 4.5 }]),
  [{ LON: 2.29, LAT: 48.85, VALUE: 4.5, LABEL: 'Cafe' }]);
eq('run_sql GEOGRAPHY column (GeoJSON string)', sqlMapRows([{ GEOM: JSON.stringify(poly), AREA_KM2: 3 }]),
  [{ GEOJSON: poly, VALUE: 3 }]);
eq('run_sql non-spatial result -> nothing to draw', sqlMapRows([{ REGION: 'Paris', TRIPS: 10 }]), []);
eq('run_sql empty result', sqlMapRows([]), []);

// Budget is in ESCAPED bytes (the unit of cortex PR 157597's 200 KB ceiling):
// a quote-heavy label set must stop at ROWS_MAX once escaped, not raw.
eq('escapedLen counts JSON escapes', escapedLen('{"a":"x\\y"}'), 16);
const quoty = Array.from({ length: 5000 }, (_, i) => ({
  LATITUDE: 37 + i / 1e4, LONGITUDE: -122, NAME: `"Joe's" "Bar" #${i} ${'"'.repeat(120)}` }));
const bounded = sqlMapRows(quoty);
const esc = escapedLen(JSON.stringify(bounded));
eq('run_sql rows <= 190 KB escaped', esc <= 190_000, true);
eq('run_sql rows budget binds (> 180 KB escaped)', esc > 180_000, true);
eq('raw count would have under-measured', JSON.stringify(bounded).length < esc, true);

console.log(bad ? `${bad} failure(s)` : 'all shapes OK');
process.exit(bad ? 1 : 0);

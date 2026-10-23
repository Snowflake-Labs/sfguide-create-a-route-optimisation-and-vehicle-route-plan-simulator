// Offline: the extractor handles every geometry shape the TOOL_* procs return.
// Run with: npx tsx verify_cowork_rows_shapes.mts   (from fleet_tools/user)
import { collectGeometries, pointRows, routeGeometries, snappedPoints, featurePoints } from './src/map_rows.js';

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

console.log(bad ? `${bad} failure(s)` : 'all shapes OK');
process.exit(bad ? 1 : 0);

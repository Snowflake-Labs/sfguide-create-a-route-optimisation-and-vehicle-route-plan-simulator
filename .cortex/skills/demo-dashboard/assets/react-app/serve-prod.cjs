const express = require('express');
const path = require('path');
const https = require('https');

const app = express();
app.use(express.json());

const DIST = path.join(__dirname, 'dist');

app.get('/api/registry', (_, res) => res.json([{
  demo_id: 'travel-time-matrix', display_name: 'Travel Time Matrix',
  description: 'Mock', icon: 'timer', sort_order: 1,
  source_db: 'MOCK_DB', source_schema: 'MOCK_SCHEMA',
  pages: [{ id: 'travel-time-matrix', path: '/travel-time', title: 'Travel Time Explorer' }],
  requires_ors: false, installed: true, installed_at: '2026-01-01', version: '1.0', config: {},
}]));
app.get('/api/ors/status', (_, res) => res.json({ installed: false, status: 'not_installed' }));
app.get('/api/regions', (_, res) => res.json({
  active: 'SanFrancisco',
  regions: [{ REGION_NAME: 'SanFrancisco', DISPLAY_NAME: 'San Francisco',
    CENTER_LAT: 37.7749, CENTER_LON: -122.4194,
    BBOX_MIN_LAT: 37.700, BBOX_MAX_LAT: 37.820, BBOX_MIN_LON: -122.520, BBOX_MAX_LON: -122.350,
    ZOOM_LEVEL: 11, ORS_REGION_KEY: null, DATA_SOURCE: 'mock' }],
}));
app.get('/api/matrix/viewer-inventory', (_, res) => res.json({ tables: [{
  region: 'SanFrancisco', profile: 'driving-car', resolution: 'RES8',
  row_count: 50000, bytes: 5000000, table_name: 'MOCK_TABLE',
  full_table: 'MOCK.MOCK.MOCK_TABLE',
}]}));
app.get('/api/matrix/random-origin', (_, res) => res.json({
  origin_hex: '8828308281fffff', origin_lat: 37.7749, origin_lon: -122.4194,
  global_max_time_secs: 3600,
}));
app.get('/api/matrix/all-hexes', (_, res) => res.json({ hexes: [
  '8828308281fffff','882830828bfffff','8828308283fffff','882830829dfffff',
  '8828308285fffff','882830828dfffff','8828308287fffff','882830829bfffff',
  '8828308289fffff','8828308295fffff','882830829ffffff','8828308291fffff',
]}));
app.get('/api/matrix/reachability', (_, res) => res.json({
  destinations: [
    { HEX_ID:'882830828bfffff', LAT:37.780, LON:-122.425, TRAVEL_TIME_SECONDS:120, TRAVEL_DISTANCE_METERS:1500 },
    { HEX_ID:'8828308283fffff', LAT:37.770, LON:-122.410, TRAVEL_TIME_SECONDS:300, TRAVEL_DISTANCE_METERS:3000 },
    { HEX_ID:'882830829dfffff', LAT:37.785, LON:-122.430, TRAVEL_TIME_SECONDS:450, TRAVEL_DISTANCE_METERS:4500 },
    { HEX_ID:'8828308285fffff', LAT:37.765, LON:-122.400, TRAVEL_TIME_SECONDS:600, TRAVEL_DISTANCE_METERS:6000 },
  ],
  origin_lat: 37.7749, origin_lon: -122.4194,
}));
app.get('/api/tiles/:z/:x/:y', (req, res) => {
  const url = `https://a.basemaps.cartocdn.com/light_all/${req.params.z}/${req.params.x}/${req.params.y}.png`;
  https.get(url, r => { res.set('content-type', 'image/png'); r.pipe(res); }).on('error', () => res.status(404).send(''));
});

app.use(express.static(DIST));
app.get('*', (_, res) => res.sendFile(path.join(DIST, 'index.html')));

app.listen(4173, () => console.log('Production mock server on http://localhost:4173'));

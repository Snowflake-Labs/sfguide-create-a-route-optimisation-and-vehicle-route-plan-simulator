// Regression test for the agent-emitted MAP spec validators (map-spec-schema.ts
// and, through it, the Map-area branch of view-spec-schema.ts).
//
// Run with (from fleet_tools/user):
//   npx tsx --tsconfig ../../fleet_sa_app/ui/tsconfig.json verify_map_spec.mts
//
// The --tsconfig is REQUIRED and was not previously documented here: this file
// reaches view-spec-schema.ts, which imports AREA_COMPONENT_NAMES as a runtime
// value through the SA app's `@/` alias. Without the app tsconfig, tsx cannot
// resolve that alias and the run dies with "Cannot find module
// '@/lib/area-components'" before a single assertion executes - which reads as a
// broken harness rather than a wrong command.
//
// It lives here rather than under fleet_sa_app/ui for the same practical reason
// as verify_routing_suspend.mts: this package already carries tsx, while running
// it from the SA app UI makes npx block on an interactive install prompt and then
// re-download tsx on every invocation. map-spec-schema.ts imports ONLY types
// (`import type`), which esbuild erases, so it has no runtime imports and a
// relative import works despite the `@/` alias in its source.
//
// What it protects. Every failure mode of a map is SILENT. An unknown layer
// `type` compiles to nothing, a `viewState.*` param on an inline map binds NULL,
// and an oversized geometry payload renders blank - in all three cases the
// basemap paints, no error is raised, and the result is indistinguishable from
// "the query legitimately matched no rows". Before this validator existed, a
// `config.layers` block reached the deck.gl compiler entirely unchecked, because
// `parseDynamicSpec` treats `config` as a permissive passthrough. So the point of
// these assertions is that a bad spec is REJECTED BY NAME rather than diagnosed
// after a user reports an empty map.
//
// Both directions are asserted. Over-tightening is the opposite defect: the
// positive fixture must keep passing, `viewState.*` must stay LEGAL on the
// render_view page path (a rendered page owns a panel.viewState, unlike a chat
// message), and a plain `Table` area must not be dragged into layer validation.
import { readFileSync } from 'node:fs';
import {
  parseMapSpec,
  validateMapLayers,
  MAX_MAP_LAYERS,
  MAP_LAYER_TYPES,
  MAP_SPEC_VERSION,
  MAX_LEGEND_ITEMS,
} from '../../fleet_sa_app/ui/src/lib/map-spec-schema';
// The tool-name matcher and the result unwrapper. Pure TS, no runtime deps.
import { matchesTool, unwrapVerbResult } from '../../fleet_sa_app/ui/src/lib/tool-names';
import { inlineRegistry } from '../../fleet_sa_app/ui/src/lib/inline-registry';
import type { InlineComponentDef } from '../../fleet_sa_app/ui/src/lib/types';
import { parseDynamicSpec } from '../../fleet_sa_app/ui/src/lib/view-spec-schema';
// The verb-side copies of the shared constants, compared below. Aliased so a
// reader cannot mistake one side for the other.
import {
  MAX_MAP_LAYERS as VERB_MAX_MAP_LAYERS,
  MAP_LAYER_TYPES as VERB_MAP_LAYER_TYPES,
  MAP_SPEC_VERSION as VERB_MAP_SPEC_VERSION,
} from './src/codes';
// Geometry, the padding clamp and detection carry REAL runtime imports (h3-js),
// unlike the type-only validators above, so this package declares h3-js as a
// devDep.
//
// Imported from geo-coords and detect-geo, NOT from ./map or ./map-fit. Anything
// that reaches @deck.gl/core fails to load under tsx: deck.gl pulls
// @luma.gl/shadertools through a path that resolves to its TypeScript source and
// throws "does not provide an export named WgslReflect". That constraint is why
// the pure geometry helpers were split out of map-fit in the first place -
// nothing asserted here needs a viewport.
import {
  boundsOf,
  clampFitPadding,
  coordsFromGeoJSON,
  coordsFromH3Cell,
  DEFAULT_PADDING,
  MAX_PADDING_FRACTION,
} from '../../../../../packages/fleet-kit/src/map/geo-coords';
import { detectGeoColumns } from '../../../../../packages/fleet-kit/src/map/detect-geo';

let fails = 0;
let checks = 0;
function chk(label: string, ok: boolean, detail?: string): void {
  checks++;
  if (!ok) {
    fails++;
    console.log(`  FAIL  ${label}${detail ? ` -- ${detail}` : ''}`);
  } else {
    console.log(`  ok    ${label}`);
  }
}

/** Assert a spec is rejected AND that the reason mentions `needle`. A generic
 *  rejection is nearly as bad as none: the agent has to be told what to fix. */
function rejects(label: string, spec: unknown, needle: string): void {
  const r = parseMapSpec(spec);
  if (r.ok) {
    chk(label, false, 'spec was ACCEPTED');
    return;
  }
  const joined = r.errors.join(' | ');
  chk(label, joined.toLowerCase().includes(needle.toLowerCase()), `errors were: ${joined}`);
}

const layer = (over: Record<string, unknown> = {}) => ({
  type: 'scatterplot',
  lng: 'lon',
  lat: 'lat',
  data: { query: 'SELECT 1 AS lon, 2 AS lat', params: { region: 'context.region' } },
  ...over,
});

console.log('\n--- positive: the shipped fixture must stay valid ---');
const fixture = JSON.parse(
  readFileSync(new URL('../../fleet_sa_app/app/fixtures/render-map-dwell-density.json', import.meta.url), 'utf8'),
);
const good = parseMapSpec(fixture);
chk('2-layer h3 + scatterplot fixture is accepted', good.ok,
  good.ok ? undefined : good.errors.join(' | '));
if (good.ok) {
  chk('fixture keeps both layers', good.spec.layers.length === 2);
  chk('fixture height is honoured', good.spec.height === 380);
  chk('fixture legend survives', (good.spec.legend?.length ?? 0) === 2);
  chk('fixture emptyMessage survives', !!good.spec.emptyMessage);
}

console.log('\n--- positive: shape tolerance and clamping ---');
const nested = parseMapSpec({ config: { layers: [layer()] }, title: 'Nested' });
chk('area-shaped {config:{layers}} is accepted', nested.ok);
chk('title lifts out of the outer object', nested.ok && nested.spec.title === 'Nested');
const asString = parseMapSpec(JSON.stringify({ layers: [layer()] }));
chk('a JSON STRING spec is accepted', asString.ok);
const noHeight = parseMapSpec({ layers: [layer()] });
chk('height defaults when absent', noHeight.ok && noHeight.spec.height === 340);
const tallSpec = parseMapSpec({ layers: [layer()], height: 5000 });
chk('an absurd height is clamped, not rejected', tallSpec.ok && tallSpec.spec.height === 600);
const shortSpec = parseMapSpec({ layers: [layer()], height: 10 });
chk('a tiny height is clamped up', shortSpec.ok && shortSpec.spec.height === 200);
const allTypes = parseMapSpec({
  layers: [
    { type: 'h3', hexColumn: 'h', data: { query: 'SELECT 1 AS h' } },
    { type: 'geojson', geojsonColumn: 'g', data: { query: 'SELECT 1 AS g' } },
    { type: 'path', geojsonColumn: 'g', data: { query: 'WITH x AS (SELECT 1 AS g) SELECT * FROM x' } },
    { type: 'arc', source: { lng: 'a', lat: 'b' }, target: { lng: 'c', lat: 'd' }, data: { query: 'SELECT 1' } },
  ],
});
chk('all four remaining layer types are accepted', allTypes.ok,
  allTypes.ok ? undefined : allTypes.errors.join(' | '));
chk('a WITH query is accepted as read-only', allTypes.ok);

console.log('\n--- negative: layer type and structure ---');
rejects('unknown layer type is named', { layers: [layer({ type: 'heatmap' })] }, 'not a known layer type');
rejects('the offending type value is quoted back', { layers: [layer({ type: 'heatmap' })] }, "'heatmap'");
rejects('empty layers array', { layers: [] }, 'non-empty array');
rejects('missing layers', { title: 'x' }, 'non-empty array');
rejects('layers as an object, not an array', { layers: { a: layer() } }, 'non-empty array');
rejects('a non-object layer', { layers: ['scatterplot'] }, 'must be an object');
rejects('not a JSON object at all', '[1,2,3]', 'must be a JSON object');
rejects('malformed JSON string', '{oops', 'not valid JSON');

console.log('\n--- negative: the query contract ---');
rejects('a layer with no query', { layers: [{ type: 'scatterplot', lng: 'a', lat: 'b', data: {} }] }, 'requires data.query');
rejects('a layer with no data block', { layers: [{ type: 'scatterplot', lng: 'a', lat: 'b' }] }, 'requires data.query');
rejects('a writing statement',
  { layers: [layer({ data: { query: 'DELETE FROM FLEET_APP.DWELL.VW_DWELL_ENRICHED' } })] },
  'SELECT/WITH');
rejects('a CALL statement',
  { layers: [layer({ data: { query: 'CALL FLEET_APP.CORE.QUERY_DYNAMIC(\'x\')' } })] },
  'SELECT/WITH');
rejects('an empty query string', { layers: [layer({ data: { query: '   ' } })] }, 'requires data.query');
rejects('params as an array', { layers: [layer({ data: { query: 'SELECT 1', params: ['region'] } })] }, 'must be an object');

console.log('\n--- negative: inline maps have no view state ---');
// This is the case a naive validator misses entirely: the spec is structurally
// perfect and the query is read-only, so it is ACCEPTED, runs, binds NULL, and
// returns zero rows. A blank map with no error.
rejects('a viewState.* param is rejected on an inline map',
  { layers: [layer({ data: { query: 'SELECT 1', params: { trip: 'viewState.selected_trip' } } })] },
  'no view state');
rejects('the rejected param is named',
  { layers: [layer({ data: { query: 'SELECT 1', params: { trip: 'viewState.selected_trip' } } })] },
  'data.params.trip');
rejects('visibleWhen is rejected on an inline map', { layers: [layer({ visibleWhen: 'show_sites' })] }, 'visibleWhen');
rejects('toggles are rejected', { layers: [layer()], toggles: [{ key: 'k', label: 'L' }] }, 'toggles');
rejects('clickEmits are rejected', { layers: [layer()], clickEmits: { object: 'poi_name' } }, 'clickEmits');
rejects('focusOn is rejected', { layers: [layer()], focusOn: { lngKey: 'a', latKey: 'b' } }, 'focusOn');

console.log('\n--- negative: the layer cap ---');
rejects(`more than ${MAX_MAP_LAYERS} layers is rejected`,
  { layers: [layer(), layer(), layer(), layer(), layer()] },
  `at most ${MAX_MAP_LAYERS}`);
const atCap = parseMapSpec({ layers: [layer(), layer(), layer(), layer()] });
chk(`exactly ${MAX_MAP_LAYERS} layers is ACCEPTED (off-by-one guard)`, atCap.ok,
  atCap.ok ? undefined : atCap.errors.join(' | '));

console.log('\n--- the render_view page path keeps its own rules ---');
// viewState.* MUST stay legal here. Narrowing the inline rule onto this path
// would break every authored-style page an agent emits with a selection.
const pageErrors: string[] = [];
validateMapLayers([layer({ data: { query: 'SELECT 1', params: { trip: 'viewState.selected_trip' } } })],
  pageErrors, { allowViewState: true });
chk('viewState.* is legal on a rendered PAGE', pageErrors.length === 0, pageErrors.join(' | '));

const pageSpec = (layers: unknown) => ({
  label: 'Generated',
  layout: { default: { columns: '1fr', grid: '"m"' } },
  areas: { m: { component: 'Map', config: { layers } } },
});
const pageOk = parseDynamicSpec(pageSpec([layer()]));
chk('a valid Map area passes parseDynamicSpec', pageOk.ok,
  pageOk.ok ? undefined : pageOk.errors.join(' | '));

// The defect this closes: before the Map branch existed, `config` was a
// permissive passthrough and THIS spec was accepted, then rendered blank.
const pageBad = parseDynamicSpec(pageSpec([{ type: 'heatmap', data: { query: 'SELECT 1' } }]));
chk('an unknown layer type now fails parseDynamicSpec', !pageBad.ok);
chk('and the failing area is named',
  !pageBad.ok && pageBad.errors.join(' | ').includes("area 'm'"),
  pageBad.ok ? 'accepted' : pageBad.errors.join(' | '));
const pageNoLayers = parseDynamicSpec(pageSpec(undefined));
chk('a Map area with no layers fails parseDynamicSpec', !pageNoLayers.ok);

// A non-Map area must NOT be dragged into layer validation.
const tableOnly = parseDynamicSpec({
  label: 'Generated',
  layout: { default: { columns: '1fr', grid: '"t"' } },
  areas: { t: { component: 'Table', data: { query: 'SELECT 1' } } },
});
chk('a Table area is unaffected by the Map branch', tableOnly.ok,
  tableOnly.ok ? undefined : tableOnly.errors.join(' | '));

// ---------------------------------------------------------------------------
// Spec version.
//
// Absent must keep meaning 1, or every spec already written (17 Map areas in
// app-views.json, every render_map call) becomes invalid on the deploy that
// introduces the field.
const vAbsent = parseMapSpec({ layers: [{ type: 'scatterplot', lng: 'LNG', lat: 'LAT', data: { query: 'SELECT 1' } }] });
chk('a spec with no version is accepted and defaults to 1',
  vAbsent.ok && vAbsent.spec.version === MAP_SPEC_VERSION,
  vAbsent.ok ? `version=${vAbsent.spec.version}` : vAbsent.errors.join(' | '));

const vFuture = parseMapSpec({ version: MAP_SPEC_VERSION + 1, layers: [{ type: 'scatterplot', lng: 'LNG', lat: 'LAT', data: { query: 'SELECT 1' } }] });
chk('a spec from a newer build is REJECTED, not rendered partially', !vFuture.ok,
  vFuture.ok ? 'accepted' : undefined);

const vJunk = parseMapSpec({ version: 'one', layers: [{ type: 'scatterplot', lng: 'LNG', lat: 'LAT', data: { query: 'SELECT 1' } }] });
chk('a non-integer version is rejected', !vJunk.ok, vJunk.ok ? 'accepted' : undefined);

// The constants exist twice, on opposite sides of a trust boundary: the verb runs
// in Snowflake, the validator in the browser. "MUST stay in sync" was asserted by
// nothing but a comment until now.
chk('MAX_MAP_LAYERS agrees across the trust boundary',
  MAX_MAP_LAYERS === VERB_MAX_MAP_LAYERS,
  `client=${MAX_MAP_LAYERS} verb=${VERB_MAX_MAP_LAYERS}`);
chk('MAP_SPEC_VERSION agrees across the trust boundary',
  MAP_SPEC_VERSION === VERB_MAP_SPEC_VERSION,
  `client=${MAP_SPEC_VERSION} verb=${VERB_MAP_SPEC_VERSION}`);
chk('MAP_LAYER_TYPES agrees across the trust boundary',
  [...MAP_LAYER_TYPES].sort().join(',') === [...VERB_MAP_LAYER_TYPES].sort().join(','),
  `client=${MAP_LAYER_TYPES.join('|')} verb=${VERB_MAP_LAYER_TYPES.join('|')}`);

// ---------------------------------------------------------------------------
// Camera fit.
//
// The fit is the other silent failure surface: it cannot render an error, it can
// only point the camera somewhere useless.
const H3_CELL = '881f1d4e17fffff';

chk('a valid H3 cell yields boundary vertices', coordsFromH3Cell(H3_CELL).length === 6,
  `${coordsFromH3Cell(H3_CELL).length} vertices`);
// 15 hex chars, so the previous `length < 15` heuristic admitted it. NOTE: this
// assertion documents the contract, it does not guard the isValidCell change -
// negative-tested by reverting to the length heuristic, and it still passed,
// because cellToBoundary throws for that string and the catch returns []. The
// assertion that actually convicts the heuristic is 'detect: NEG same-length hex
// non-cell' below, where a length test binds an h3 layer to unrelated ids.
chk('a same-length non-cell yields nothing', coordsFromH3Cell('fffffffffffffff').length === 0);
chk('a non-string cell yields nothing', coordsFromH3Cell(null).length === 0);
chk('an out-of-range coordinate never enters a bounds box',
  boundsOf([[181, 0]] as [number, number][]) === null);

// One unusable row must not drag the extent; skipped, never clamped.
const withJunk = boundsOf([[10, 10], [999, 55], [20, 20]] as [number, number][]);
chk('an out-of-range coordinate is excluded from bounds',
  JSON.stringify(withJunk) === JSON.stringify([[10, 10], [20, 20]]),
  JSON.stringify(withJunk));
chk('an all-unusable coord list produces no bounds',
  boundsOf([[999, 999]] as [number, number][]) === null);

// Padding clamp. Measured against deck.gl 9.2: at 600x60 a flat 40px inset makes
// fitBounds THROW, and fitBoundsToData catches it and returns `fallback` - which
// MapView deliberately does not pass, so the camera silently never fits at all.
// At 600x90 it does not throw but returns zoom 1.145 for a 2-degree box.
const shortPad = clampFitPadding(DEFAULT_PADDING, 600, 60);
chk('a short canvas has its inset clamped below the viewport',
  shortPad.top + shortPad.bottom < 60,
  `top+bottom=${shortPad.top + shortPad.bottom} of 60`);
chk('the clamp ceiling is the documented fraction of the smaller side',
  shortPad.top === Math.floor(60 * MAX_PADDING_FRACTION),
  `top=${shortPad.top} expected=${Math.floor(60 * MAX_PADDING_FRACTION)}`);
const tallPad = clampFitPadding(DEFAULT_PADDING, 600, 400);
chk('a tall canvas keeps the full default inset',
  tallPad.top === DEFAULT_PADDING.top,
  `top=${tallPad.top}`);
chk('a negative inset is floored at zero',
  clampFitPadding({ top: -10, bottom: -10, left: -10, right: -10 }, 600, 400).top === 0);

// Recursive walker parity: the per-geometry-type switch it replaced enumerated
// these by hand, so each nesting depth needs to still be reached.
chk('a nested MultiPolygon is walked',
  coordsFromGeoJSON({ type: 'MultiPolygon', coordinates: [[[[0, 0], [1, 0], [1, 1], [0, 0]]]] }).length === 4);
chk('a GeometryCollection is walked',
  coordsFromGeoJSON({ type: 'GeometryCollection', geometries: [{ type: 'Point', coordinates: [1, 2] }, { type: 'LineString', coordinates: [[3, 4], [5, 6]] }] }).length === 3);
chk('a GeoJSON string is parsed',
  coordsFromGeoJSON('{"type":"LineString","coordinates":[[1,2],[3,4]]}').length === 2);
chk('unparseable GeoJSON yields nothing', coordsFromGeoJSON('{not json').length === 0);

// ---------------------------------------------------------------------------
// Geo detection.
//
// The negatives carry the weight. A missed detection shows no map, which is
// obvious; a WRONG detection renders real-looking data in the wrong hemisphere.
const col = (name: string, type: string) => ({ name, type });

const detCases: Array<[string, ReturnType<typeof col>[], Record<string, unknown>[], string | undefined]> = [
  ['GEOGRAPHY metadata wins', [col('GEOM', 'GEOGRAPHY'), col('N', 'TEXT')], [{ GEOM: null, N: 'a' }], 'geojson'],
  ['ST_ASGEOJSON string', [col('TRAIL', 'TEXT')], [{ TRAIL: '{"type":"LineString","coordinates":[[1,2],[3,4]]}' }], 'geojson'],
  ['H3 cells', [col('CELL', 'TEXT')], [{ CELL: H3_CELL }, { CELL: '881f1d4e1bfffff' }], 'h3'],
  ['lat/lon pair', [col('LAT', 'REAL'), col('LON', 'REAL')], [{ LAT: 51.5, LON: -0.1 }], 'scatterplot'],
  ['NEG x/y holding prices', [col('X', 'REAL'), col('Y', 'REAL')], [{ X: 1200.5, Y: 45.2 }, { X: 990, Y: 12.1 }], undefined],
  ['NEG 15-char order ids', [col('ORDER_ID', 'TEXT')], [{ ORDER_ID: 'ORD00012345678' }], undefined],
  ['NEG same-length hex non-cell', [col('H', 'TEXT')], [{ H: 'fffffffffffffff' }], undefined],
  ['NEG lon column missing', [col('LAT', 'REAL'), col('AMT', 'REAL')], [{ LAT: 51.5, AMT: 9 }], undefined],
  ['NEG lat out of range', [col('LAT', 'REAL'), col('LON', 'REAL')], [{ LAT: 151.5, LON: -0.1 }], undefined],
  ['NEG all-null coordinates', [col('LAT', 'REAL'), col('LON', 'REAL')], [{ LAT: null, LON: null }], undefined],
  ['NEG latency is not latitude', [col('LATENCY_MS', 'REAL'), col('LON', 'REAL')], [{ LATENCY_MS: 42, LON: -0.1 }], undefined],
  ['NEG json that is not GeoJSON', [col('PAYLOAD', 'TEXT')], [{ PAYLOAD: '{"a":1}' }], undefined],
  ['NEG no columns at all', [], [], undefined],
];
for (const [label, cols, rows, want] of detCases) {
  const got = detectGeoColumns(cols, rows);
  chk(`detect: ${label}`, (got?.type ?? undefined) === want,
    `got ${got ? `${got.type} (${got.reason})` : 'undefined'}`);
}

// A detected binding must survive the validator it feeds, or detection produces
// specs the app then refuses.
const det = detectGeoColumns([col('LAT', 'REAL'), col('LON', 'REAL')], [{ LAT: 51.5, LON: -0.1 }]);
const fromDetection = parseMapSpec({
  layers: [{ type: det?.type, lng: det?.lng, lat: det?.lat, data: { query: 'SELECT 1' } }],
});
chk('a detected binding passes the map spec validator', fromDetection.ok,
  fromDetection.ok ? undefined : fromDetection.errors.join(' | '));

// ---------------------------------------------------------------------------
// Tool-name resolution and result unwrapping.
//
// These two carried the whole "the agent drew no map" defect. render_map ran
// fine (VERB_ATTEMPT outcome 'ok', three times) but the chat client rendered a
// JSON blob, because the streamed name is `routing_mcp_render_map` - ONE
// underscore - while the registry fell back on lastIndexOf('__'). The MEASURED
// name comes from FLEET_INTELLIGENCE.SEMANTIC_OPS.AGENT_TURN.TOOLS_USED; it is
// hardcoded below so a future separator change fails here rather than in a demo.
const REAL_MCP_NAME = 'routing_mcp_render_map';

const nameCases: Array<[string, string, string, boolean]> = [
  ['the MEASURED single-underscore MCP name resolves', REAL_MCP_NAME, 'render_map', true],
  ['a bare verb name resolves', 'render_map', 'render_map', true],
  ['a double-underscore prefix still resolves', 'routing_mcp__render_map', 'render_map', true],
  ['a different server prefix resolves', 'fleet_ops_mcp_render_map', 'render_map', true],
  ['NEG a different verb does not match', REAL_MCP_NAME, 'render_view', false],
  // Guards the sloppy fix: matching a bare substring would let `render_map`
  // answer for `render_map_legend`, and stripping to the last `_` would make
  // every verb whose name contains an underscore resolve to its own tail.
  ['NEG a longer verb name is not matched by its tail', 'routing_mcp_render_map_v2', 'render_map', false],
  ['NEG suffix must be underscore-delimited', 'xrender_map', 'render_map', false],
];
for (const [label, toolName, bare, want] of nameCases) {
  chk(`toolname: ${label}`, matchesTool(toolName, bare) === want,
    `matchesTool(${JSON.stringify(toolName)}, ${JSON.stringify(bare)}) === ${!want}`);
}
chk('toolname: undefined never matches', matchesTool(undefined, 'render_map') === false);

// The registry must resolve the real name to the registered component. Dummy
// components only: importing components/inline/index.ts would pull deck.gl,
// which cannot load under tsx (see the header note on @luma.gl/shadertools).
const dummy = (() => null) as unknown as InlineComponentDef['component'];
for (const n of ['render_map', 'render_view', 'render_table', 'propose_write']) {
  inlineRegistry.register({ toolName: n, component: dummy });
}
chk('registry: resolves the measured MCP name',
  inlineRegistry.get(REAL_MCP_NAME) !== undefined);
chk('registry: resolves a bare name', inlineRegistry.get('render_table') !== undefined);
chk('registry: an unregistered tool still returns undefined (JSON viewer is a legal state)',
  inlineRegistry.get('routing_mcp_backload_solve') === undefined);

// The EXACT payload observed on screen: the verb's {result: spec} envelope
// arrives wrapped a second time, with the inner envelope as a pretty-printed
// JSON string. Written as the raw literal rather than rebuilt from an object so
// the double encoding cannot be lost to a refactor.
const OBSERVED_SPEC = {
  height: 600,
  layers: [
    {
      data: {
        params: { region: 'context.region' },
        query:
          'SELECT H3_CELL_R7 AS hex, COUNT(*) AS dwell_count, AVG(DWELL_MINUTES) AS avg_dwell_min ' +
          'FROM FLEET_APP.DWELL.VW_DWELL_SESSIONS WHERE REGION = :region GROUP BY H3_CELL_R7',
      },
      hexColumn: 'HEX',
      tooltip: 'Dwell sessions: {DWELL_COUNT} | Avg dwell: {AVG_DWELL_MIN} min',
      type: 'h3',
      valueColumn: 'DWELL_COUNT',
    },
  ],
  legend: [
    { color: '#ffffcc', label: 'Low dwell density' },
    { color: '#fd8d3c', label: 'Medium dwell density' },
    { color: '#800026', label: 'High dwell density' },
  ],
  title: 'Dwell Density - United States (HGV)',
};
const doubleWrapped = { result: JSON.stringify({ result: OBSERVED_SPEC }, null, 2) };

const unwrapCases: Array<[string, unknown]> = [
  ['the observed double-wrapped payload', doubleWrapped],
  ['a single-wrapped payload', { result: OBSERVED_SPEC }],
  ['a bare spec', OBSERVED_SPEC],
  ['a spec as a JSON string', JSON.stringify(OBSERVED_SPEC)],
  ['a triple-wrapped payload', { result: JSON.stringify({ result: { result: OBSERVED_SPEC } }) }],
];
for (const [label, raw] of unwrapCases) {
  const r = parseMapSpec(unwrapVerbResult(raw));
  chk(`unwrap: ${label} parses to a valid spec`, r.ok,
    r.ok ? undefined : r.errors.join(' | '));
}
// The pre-fix consumer read `.result` once. Assert that path still FAILS, so the
// test cannot pass against the code it was written to convict.
chk('unwrap: NEG reading .result once leaves a string that does not validate',
  parseMapSpec((doubleWrapped as { result: unknown }).result).ok === false);
// Termination: a self-referential envelope must not spin.
const cyclic: Record<string, unknown> = {};
cyclic.result = cyclic;
chk('unwrap: a cyclic envelope terminates', unwrapVerbResult(cyclic) !== undefined);
// A non-JSON string is returned as-is rather than swallowed.
chk('unwrap: a plain string is passed through', unwrapVerbResult('not json') === 'not json');
// Stops on the spec body even when the spec itself carries a `result` field.
const specWithResult = { ...OBSERVED_SPEC, result: 'do not peel me' };
chk('unwrap: stops at the spec body rather than peeling its own result field',
  (unwrapVerbResult({ result: specWithResult }) as Record<string, unknown>).result === 'do not peel me');

// ---------------------------------------------------------------------------
// Legend colours.
//
// LegendItem.color is a ColorRGBA 4-tuple, but an LLM writes '#ffffcc' every
// time, and the validator used to cast `body.legend` through unchecked. The
// swatch then rendered as rgba(#, f, f, ...) - invalid CSS, invisible, no error.
// So the hex form is ACCEPTED and normalized rather than merely rejected: the
// agent's natural output has to work.
const legendOk = parseMapSpec(OBSERVED_SPEC);
chk('legend: the observed hex legend is accepted', legendOk.ok,
  legendOk.ok ? undefined : legendOk.errors.join(' | '));
if (legendOk.ok) {
  const first = legendOk.spec.legend?.[0];
  chk('legend: #ffffcc normalizes to [255,255,204,255]',
    JSON.stringify(first?.color) === JSON.stringify([255, 255, 204, 255]),
    JSON.stringify(first?.color));
}
const shortHex = parseMapSpec({ ...OBSERVED_SPEC, legend: [{ label: 'a', color: '#fc0' }] });
chk('legend: 3-digit hex expands', shortHex.ok &&
  JSON.stringify(shortHex.spec.legend?.[0].color) === JSON.stringify([255, 204, 0, 255]));
const rgbaLegend = parseMapSpec({ ...OBSERVED_SPEC, legend: [{ label: 'a', color: [1, 2, 3] }] });
chk('legend: a 3-element array gets alpha 255', rgbaLegend.ok &&
  JSON.stringify(rgbaLegend.spec.legend?.[0].color) === JSON.stringify([1, 2, 3, 255]));
const gradientLegend = parseMapSpec({
  ...OBSERVED_SPEC,
  legend: [{ label: 'density', gradient: ['#ffffcc', '#800026'], minLabel: 'low', maxLabel: 'high' }],
});
chk('legend: a gradient item is accepted without a color', gradientLegend.ok,
  gradientLegend.ok ? undefined : gradientLegend.errors.join(' | '));

rejects('legend: a bogus colour string is rejected by name',
  { ...OBSERVED_SPEC, legend: [{ label: 'a', color: 'chartreuse' }] }, 'color');
rejects('legend: an out-of-range channel is rejected',
  { ...OBSERVED_SPEC, legend: [{ label: 'a', color: [300, 0, 0, 255] }] }, 'color');
rejects('legend: a missing label is rejected',
  { ...OBSERVED_SPEC, legend: [{ color: '#ffffcc' }] }, 'label');
// The silent case that motivated requiring one of the two: a labelled item with
// no colour at all draws an invisible swatch.
rejects('legend: neither color nor gradient is rejected',
  { ...OBSERVED_SPEC, legend: [{ label: 'orphan' }] }, 'gradient');
rejects('legend: a non-array legend is rejected',
  { ...OBSERVED_SPEC, legend: { label: 'a', color: '#ffffcc' } }, 'array');
rejects('legend: over the item cap is rejected',
  { ...OBSERVED_SPEC, legend: Array.from({ length: MAX_LEGEND_ITEMS + 1 }, (_, i) => ({ label: `l${i}`, color: '#ffffcc' })) },
  'max');
rejects('legend: categoryLegend is validated too, not just legend',
  { ...OBSERVED_SPEC, categoryLegend: [{ label: 'a', color: 'nope' }] }, 'categoryLegend');

console.log(fails ? `\n${fails} FAILURE(S) of ${checks}` : `\nall ${checks} assertions passed`);
process.exit(fails ? 1 : 0);

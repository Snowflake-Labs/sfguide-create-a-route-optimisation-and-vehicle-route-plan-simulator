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
// Legend derivation + tooltip synthesis. Pure by construction (types only, no
// deck.gl), which is what makes them testable here at all - see the module
// header on why the compiler defaults are mirrored rather than imported.
import {
  deriveInlineLegend, synthesizeTooltip, humanizeColumn, formatDomainValue,
  encodingColumns, COMPILER_DEFAULTS, type LayerFacts,
} from '../../fleet_sa_app/ui/src/lib/map/inline-legend';
import type { InlineComponentDef } from '../../fleet_sa_app/ui/src/lib/types';
import { parseDynamicSpec } from '../../fleet_sa_app/ui/src/lib/view-spec-schema';
// Pure memo builders: the grounding channel the user cannot see.
import { buildKpiMemo, buildChartMemo } from '../../fleet_sa_app/ui/src/lib/agent-memo';
// Column-reference normalization for the non-Map areas (default-deny by PATH).
import { COLUMN_REF_PATHS, NO_COLUMN_REFS } from '../../fleet_sa_app/ui/src/lib/view-column-refs';
import { AREA_COMPONENT_NAMES } from '../../fleet_sa_app/ui/src/lib/area-components';
// The verb-side copies of the shared constants, compared below. Aliased so a
// reader cannot mistake one side for the other.
import {
  MAX_MAP_LAYERS as VERB_MAX_MAP_LAYERS,
  MAP_LAYER_TYPES as VERB_MAP_LAYER_TYPES,
  MAP_SPEC_VERSION as VERB_MAP_SPEC_VERSION,
  REQUIRED_LAYER_ENCODINGS as VERB_REQUIRED_ENCODINGS,
  RENDER_COMPONENTS as VERB_RENDER_COMPONENTS,
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
  // The fixture deliberately carries NO legend: it is derived from the layers.
  chk('fixture authors no legend', good.spec.legend === undefined);
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

// ---------------------------------------------------------------------------
// Picking, tooltips and the DERIVED legend.
//
// The user-visible defect: a blue H3 dwell-density map with no tooltip on hover,
// sitting under a yellow / orange / dark-red key labelled "Low / Medium / High
// dwell". OBSERVED_SPEC above is the payload that produced it, so every
// assertion here runs against the exact spec that failed rather than a
// reconstruction.
//
// Two causes, both silent. (1) The spec carries a `tooltip` but no `pickable`,
// and every compiler branch defaults `pickable: spec.pickable ?? false`, so
// deck.gl never picked and the live template could never fire. (2) The spec
// carries no `colorScale`, so the compiler lerped its own default blue ramp while
// the agent authored a colorbrewer key it had invented - nothing tied the legend
// to the encoding.
console.log('\n--- picking, tooltips and legend derivation ---');

const observed = parseMapSpec(OBSERVED_SPEC);
chk('pickable: the observed spec parses', observed.ok,
  observed.ok ? undefined : observed.errors.join(' | '));
if (observed.ok) {
  chk('pickable: forced true on an inline layer that omitted it',
    (observed.spec.layers[0] as { pickable?: unknown }).pickable === true);
}
// NEG: the pre-fix behaviour. If the field is merely passed through, the observed
// spec keeps no pickable at all and this convicts.
chk('pickable: NEG a passthrough would leave it undefined',
  (OBSERVED_SPEC.layers[0] as { pickable?: unknown }).pickable === undefined);
// An explicit false on a render_view page layer is the author's call and survives:
// a wide context choropleth under the layer that matters must stay unpickable.
const pagePickErrors: string[] = [];
const pageLayers = validateMapLayers(
  [{ ...layer(), pickable: false }], pagePickErrors, { allowViewState: true },
);
chk('pickable: an authored render_view layer keeps pickable false',
  pagePickErrors.length === 0 && (pageLayers[0] as { pickable?: unknown }).pickable === false);
// ...while the same layer on an inline map is forced on, because a chat map is
// read by hovering it and the agent has no way to know that.
const inlinePickErrors: string[] = [];
const inlineLayers = validateMapLayers(
  [{ ...layer(), pickable: false }], inlinePickErrors, { allowViewState: false },
);
chk('pickable: an inline layer is forced on even against an explicit false',
  inlinePickErrors.length === 0 && (inlineLayers[0] as { pickable?: unknown }).pickable === true);

// The mirrored compiler defaults are the colours the legend claims are drawn, so
// they must equal the literals in the compiler. Read from SOURCE because
// importing the compiler would pull @deck.gl and kill this harness under tsx.
const compilerSrc = readFileSync(
  new URL('../../../../../packages/fleet-kit/src/map/layer-compiler.ts', import.meta.url),
  'utf8',
).replace(/\s+/g, '');
const mirrored: Array<[string, number[]]> = [
  ['h3 ramp low', COMPILER_DEFAULTS.h3Scale[0]],
  ['h3 ramp high', COMPILER_DEFAULTS.h3Scale[1]],
  ['scatterplot fill', COMPILER_DEFAULTS.scatterplotFill],
  ['path colour', COMPILER_DEFAULTS.pathColor],
  ['geojson fill', COMPILER_DEFAULTS.geojsonFill],
  ['arc source', COMPILER_DEFAULTS.arcSourceColor],
  ['arc target', COMPILER_DEFAULTS.arcTargetColor],
];
for (const [name, c] of mirrored) {
  chk(`defaults: the ${name} still matches the compiler source`,
    compilerSrc.includes(`[${c.join(',')}]`), `[${c.join(',')}] not found in layer-compiler.ts`);
}

const observedFacts: Record<number, LayerFacts | undefined> = {
  0: { domain: { min: 1, max: 1420 }, columns: ['HEX', 'DWELL_COUNT', 'AVG_DWELL_MIN'] },
};
const derived = deriveInlineLegend(
  observed.ok ? observed.spec.layers : [], observedFacts, observed.ok ? observed.spec.legend : undefined,
);
chk('legend: a valueColumn layer derives exactly ONE item, not three bins',
  derived.length === 1, JSON.stringify(derived));
chk('legend: that item is a gradient over the compiler ramp',
  JSON.stringify(derived[0]?.gradient) === JSON.stringify(COMPILER_DEFAULTS.h3Scale),
  JSON.stringify(derived[0]));
chk('legend: the gradient ends carry the REAL data range',
  derived[0]?.minLabel === '1' && derived[0]?.maxLabel === '1420',
  `${derived[0]?.minLabel} .. ${derived[0]?.maxLabel}`);
chk('legend: the label falls back to the humanized value column',
  derived[0]?.label === 'Dwell count', derived[0]?.label);
// The convicting assertion: the invented colours must be GONE, not merely
// reordered next to a gradient.
const derivedJson = JSON.stringify(derived);
chk('legend: NEG the agent-authored bin colours are not drawn',
  !derivedJson.includes('255,255,204') && !derivedJson.includes('128,0,38'), derivedJson);
chk('legend: NEG the invented bin labels are gone',
  !derivedJson.includes('Low dwell') && !derivedJson.includes('High dwell'), derivedJson);

// A layer's own colorScale is honoured - the legend describes THIS map, not the
// default.
const scaled = parseMapSpec({
  ...OBSERVED_SPEC,
  layers: [{ ...OBSERVED_SPEC.layers[0], colorScale: [[10, 20, 30, 40], [50, 60, 70, 80]], legendLabel: 'Dwell load' }],
});
const scaledLegend = scaled.ok ? deriveInlineLegend(scaled.spec.layers, observedFacts) : [];
chk('legend: an authored colorScale drives the gradient',
  JSON.stringify(scaledLegend[0]?.gradient) === JSON.stringify([[10, 20, 30, 40], [50, 60, 70, 80]]),
  JSON.stringify(scaledLegend[0]));
chk('legend: legendLabel wins over the column name', scaledLegend[0]?.label === 'Dwell load');
// No usable numbers means no end labels. A bar with none is honest; an invented
// 0-100 would not be.
const noDomain = deriveInlineLegend(scaled.ok ? scaled.spec.layers : [], {});
chk('legend: a missing domain leaves the gradient unlabelled',
  !!noDomain[0]?.gradient && noDomain[0]?.minLabel === undefined);

// Categorical layers become one swatch per palette entry, coloured from the
// palette the compiler will look up.
const categorical = deriveInlineLegend([
  {
    type: 'scatterplot', lng: 'lon', lat: 'lat', data: { query: 'SELECT 1' },
    fillColor: { column: 'STATUS', palette: { IDLE: [1, 1, 1, 255], BUSY: [2, 2, 2, 255] } },
  } as never,
], {});
chk('legend: a categorical layer derives one item per palette key',
  categorical.length === 2 && categorical[0].label === 'IDLE'
  && JSON.stringify(categorical[1].color) === JSON.stringify([2, 2, 2, 255]),
  JSON.stringify(categorical));
const choropleth = deriveInlineLegend([
  {
    type: 'geojson', geojsonColumn: 'g', colorColumn: 'BAND',
    colorMap: { LOW: [3, 3, 3, 255] }, data: { query: 'SELECT 1' },
  } as never,
], {});
chk('legend: a geojson colorMap derives from the map, not fillColor',
  choropleth.length === 1 && JSON.stringify(choropleth[0].color) === JSON.stringify([3, 3, 3, 255]));
// A path/arc layer must not show a dot; the swatch has to look like what is drawn.
const lineLegend = deriveInlineLegend([
  { type: 'path', geojsonColumn: 'g', id: 'driven_route', data: { query: 'SELECT 1' } } as never,
], {});
chk('legend: a path layer gets a line swatch in the compiler colour',
  lineLegend[0]?.shape === 'line'
  && JSON.stringify(lineLegend[0]?.color) === JSON.stringify(COMPILER_DEFAULTS.pathColor));
chk('legend: a flat layer falls back to its humanized id',
  lineLegend[0]?.label === 'Driven route', lineLegend[0]?.label);
// Authored TEXT is still usable when it is unambiguous - one item for one layer.
const borrowed = deriveInlineLegend(
  [{ type: 'path', geojsonColumn: 'g', id: 'x', data: { query: 'SELECT 1' } } as never],
  {},
  [{ label: 'Planned route', color: [9, 9, 9, 255] }],
);
chk('legend: a single authored label is borrowed for a flat layer',
  borrowed[0]?.label === 'Planned route'
  // ...but its colour is NOT: the swatch stays the drawn colour.
  && JSON.stringify(borrowed[0]?.color) === JSON.stringify(COMPILER_DEFAULTS.pathColor),
  JSON.stringify(borrowed[0]));
// A mismatched count is ambiguous, so nothing is borrowed rather than mislabelled.
const notBorrowed = deriveInlineLegend(
  [{ type: 'path', geojsonColumn: 'g', id: 'lane_a', data: { query: 'SELECT 1' } } as never],
  {},
  [{ label: 'one', color: [9, 9, 9, 255] }, { label: 'two', color: [8, 8, 8, 255] }],
);
chk('legend: NEG an ambiguous authored legend is not borrowed',
  notBorrowed[0]?.label === 'Lane a', notBorrowed[0]?.label);
chk('legend: the derived legend respects the item cap',
  deriveInlineLegend([
    {
      type: 'scatterplot', lng: 'lon', lat: 'lat', data: { query: 'SELECT 1' },
      fillColor: {
        column: 'C',
        palette: Object.fromEntries(
          Array.from({ length: MAX_LEGEND_ITEMS + 5 }, (_, i) => [`k${i}`, [1, 2, 3, 255]]),
        ),
      },
    } as never,
  ], {}).length === MAX_LEGEND_ITEMS);

// Exact up to 4 digits, then compact: a legend end label must stay readable
// without inventing precision it does not have.
chk('format: a compact domain label', formatDomainValue(1_420) === '1420'
  && formatDomainValue(25_000) === '25k'
  && formatDomainValue(2_300_000) === '2.3M' && formatDomainValue(0.5) === '0.5');
chk('format: SNAKE_CASE humanizes', humanizeColumn('TOTAL_DWELL_MINUTES') === 'Total dwell minutes');

// Tooltip synthesis. Forcing `pickable` alone fixes nothing for a spec that
// omits `tooltip`: getTooltip returns null and the map stays hover-dead.
const synth = synthesizeTooltip(
  { type: 'h3', hexColumn: 'HEX', valueColumn: 'DWELL_COUNT', data: { query: 'SELECT 1' } } as never,
  ['HEX', 'DWELL_COUNT', 'AVG_DWELL_MIN'],
);
chk('tooltip: synthesized from the row columns', !!synth && synth.includes('{DWELL_COUNT}'), synth);
chk('tooltip: the coloured measure leads', !!synth && synth.indexOf('{DWELL_COUNT}') < synth.indexOf('{HEX}'), synth);
chk('tooltip: no columns means no template (an empty black box is worse)',
  synthesizeTooltip({ type: 'h3', hexColumn: 'HEX', data: { query: 'SELECT 1' } } as never, []) === undefined);
// Geometry and raw coordinates are excluded: a tooltip full of WKT is unreadable.
const geoSynth = synthesizeTooltip(
  { type: 'geojson', geojsonColumn: 'ZIP_GEOJSON', colorColumn: 'BAND', data: { query: 'SELECT 1' } } as never,
  ['ZIP_GEOJSON', 'BAND', 'ZIP'],
);
chk('tooltip: the geometry column is excluded',
  !!geoSynth && !geoSynth.includes('{ZIP_GEOJSON}') && geoSynth.includes('{BAND}'), geoSynth);
const pointSynth = synthesizeTooltip(
  { type: 'scatterplot', lng: 'SITE_LON', lat: 'SITE_LAT', data: { query: 'SELECT 1' } } as never,
  ['SITE_NAME', 'SITE_LON', 'SITE_LAT', 'VISITS'],
);
chk('tooltip: lng/lat are excluded from a scatterplot template',
  !!pointSynth && !pointSynth.includes('{SITE_LON}') && pointSynth.includes('{SITE_NAME}'), pointSynth);
chk('tooltip: at most 4 tokens are emitted',
  (synthesizeTooltip(
    { type: 'h3', hexColumn: 'H', data: { query: 'SELECT 1' } } as never,
    ['H', 'A', 'B', 'C', 'D', 'E'],
  ) ?? '').match(/\{/g)?.length === 4);

// ---------------------------------------------------------------------------
// Column-name CASE, and the encoding fields a layer type cannot draw without.
//
// The defect: "show me density of pois within 45 min ebike travel time around SF
// airport" drew an EMPTY world-zoom map whose legend correctly read "POI Count
// 1..68". The query was perfect - 68 is the real top cell. The spec said
// `hexColumn: "H3_CELL"`, but /api/query builds every row key as
// `col.name.toLowerCase()`, so the compiler's `has(row, 'H3_CELL')` matched
// nothing: no hexagons, no camera-fit coords (hence world zoom), no error. The
// legend still filled in because `valueDomain` is the ONE case-insensitive
// lookup in the pipeline, which is precisely what made it look like a rendering
// bug instead of a naming one. render_map's own tool description teaches those
// names in caps, so the agent was following instructions.
//
// Two properties are asserted here: refs are lowercased (so either case works),
// and a layer missing its encoding is rejected BY NAME rather than drawn blank.
const upperErrs: string[] = [];
const upperLayers = validateMapLayers(
  [{
    type: 'h3',
    hexColumn: 'H3_CELL',
    valueColumn: 'POI_COUNT',
    tooltip: '{H3_CELL}: {POI_COUNT}',
    data: { query: 'SELECT 1' },
  }],
  upperErrs,
  { allowViewState: false },
);
chk('case: an UPPERCASE spec is accepted', upperErrs.length === 0, upperErrs.join('; '));
chk('case: hexColumn is lowercased to match the row keys',
  (upperLayers[0] as { hexColumn?: string }).hexColumn === 'h3_cell',
  JSON.stringify(upperLayers[0]));
chk('case: valueColumn is lowercased too',
  (upperLayers[0] as { valueColumn?: string }).valueColumn === 'poi_count');
// The tooltip is NOT lowercased: renderTooltip resolves its tokens
// case-insensitively, and lowering the template would corrupt the visible label.
chk('case: the tooltip template is left alone',
  (upperLayers[0] as { tooltip?: string }).tooltip === '{H3_CELL}: {POI_COUNT}');

const nestedLayers = validateMapLayers(
  [{
    type: 'arc',
    source: { lng: 'ORIGIN_LON', lat: 'ORIGIN_LAT' },
    target: { lng: 'DEST_LON', lat: 'DEST_LAT' },
    data: { query: 'SELECT 1' },
  }],
  [],
  { allowViewState: false },
);
const arcSpec = nestedLayers[0] as { source: { lng: string; lat: string }; target: { lng: string } };
chk('case: nested source/target lng+lat are lowercased',
  arcSpec.source.lng === 'origin_lon' && arcSpec.source.lat === 'origin_lat'
  && arcSpec.target.lng === 'dest_lon');

// Nested objects must be REPLACED, not mutated: an authored dashboard map hands
// in objects that belong to the parsed, cached app-views.json.
const shared = { lng: 'ORIGIN_LON', lat: 'ORIGIN_LAT' };
validateMapLayers(
  [{ type: 'arc', source: shared, target: { lng: 'A', lat: 'B' }, data: { query: 'SELECT 1' } }],
  [], { allowViewState: false },
);
chk('case: the caller\'s nested object is not mutated', shared.lng === 'ORIGIN_LON', shared.lng);

const catLayers = validateMapLayers(
  [{
    type: 'scatterplot',
    lng: 'LON',
    lat: 'LAT',
    fillColor: { column: 'STATUS', palette: { idle: [1, 2, 3, 4] } },
    data: { query: 'SELECT 1' },
  }],
  [], { allowViewState: false },
);
chk('case: a categorical colour column is lowercased',
  ((catLayers[0] as { fillColor: { column: string } }).fillColor).column === 'status');
chk('case: an [r,g,b,a] tuple survives the colour walk untouched',
  JSON.stringify((validateMapLayers(
    [{ type: 'h3', hexColumn: 'H', fillColor: [1, 2, 3, 4], data: { query: 'SELECT 1' } }],
    [], { allowViewState: false },
  )[0] as { fillColor: unknown }).fillColor) === '[1,2,3,4]');

// Required encodings. Each of these previously validated cleanly and rendered a
// blank basemap, because the compiler filters on the missing column.
for (const [label, layer] of [
  ['h3 with no hexColumn', { type: 'h3', valueColumn: 'poi_count', data: { query: 'SELECT 1' } }],
  ['scatterplot with no lat', { type: 'scatterplot', lng: 'lon', data: { query: 'SELECT 1' } }],
  ['geojson with no geojsonColumn', { type: 'geojson', data: { query: 'SELECT 1' } }],
  ['arc with no target', { type: 'arc', source: { lng: 'a', lat: 'b' }, data: { query: 'SELECT 1' } }],
  ['path with neither geometry nor endpoints', { type: 'path', data: { query: 'SELECT 1' } }],
] as [string, unknown][]) {
  const errs: string[] = [];
  validateMapLayers([layer], errs, { allowViewState: false });
  chk(`encoding: NEG ${label} is rejected`,
    errs.length === 1 && errs[0].includes('missing'), errs.join('; '));
}
// And the legal shapes are NOT dragged in with them.
for (const [label, layer] of [
  ['path with a geojsonColumn', { type: 'path', geojsonColumn: 'g', data: { query: 'SELECT 1' } }],
  ['path with start+end', {
    type: 'path',
    start: { lng: 'a', lat: 'b' },
    end: { lng: 'c', lat: 'd' },
    data: { query: 'SELECT 1' },
  }],
  ['h3 with no valueColumn (flat shade is legal)', { type: 'h3', hexColumn: 'h', data: { query: 'SELECT 1' } }],
] as [string, unknown][]) {
  const errs: string[] = [];
  validateMapLayers([layer], errs, { allowViewState: false });
  chk(`encoding: ${label} is accepted`, errs.length === 0, errs.join('; '));
}
// The page path enforces it too: a Map area with an encoding-less layer is the
// same blank map, and `config` is a permissive passthrough without this.
//
// `grid` is a STRING here, and that detail is load-bearing. The first draft of
// this assertion passed a nested array, which parseDynamicSpec rejects with
// "layout.default.grid (string) is required" - so `!ok` was true whatever the
// layers did, and the assertion survived a mutation that disabled the check it
// exists to prove. Assert the SPECIFIC error, and keep a positive control beside
// it so the fixture cannot rot into being rejected for an unrelated reason.
const mapArea = (layer: unknown) => JSON.stringify({
  layout: { default: { grid: '"m"' } },
  areas: { m: { component: 'Map', config: { layers: [layer] } } },
});
const badArea = parseDynamicSpec(mapArea({ type: 'h3', data: { query: 'SELECT 1' } }));
chk('encoding: NEG the render_view Map path rejects it as well',
  !badArea.ok && badArea.errors.some((e) => e.includes('missing hexColumn')),
  badArea.ok ? 'accepted' : badArea.errors.join('; '));
const goodArea = parseDynamicSpec(mapArea({ type: 'h3', hexColumn: 'h', data: { query: 'SELECT 1' } }));
chk('encoding: the same Map area with hexColumn is ACCEPTED (control)',
  goodArea.ok, goodArea.ok ? '' : goodArea.errors.join('; '));

// Verb/client parity. The verb fails IN-TURN so the agent can fix the spec; the
// client is the backstop. Two lists mean two chances to drift.
chk('parity: required-encoding tables agree',
  JSON.stringify(Object.keys(VERB_REQUIRED_ENCODINGS).sort())
  === JSON.stringify(['arc', 'geojson', 'h3', 'scatterplot']),
  Object.keys(VERB_REQUIRED_ENCODINGS).join(','));
for (const [type, fields] of Object.entries(VERB_REQUIRED_ENCODINGS)) {
  const errs: string[] = [];
  validateMapLayers([{ type, data: { query: 'SELECT 1' } }], errs, { allowViewState: false });
  chk(`parity: the client also rejects a bare '${type}' (verb needs ${fields.join('+')})`,
    errs.length === 1, errs.join('; '));
}

// ---------------------------------------------------------------------------
// encodingColumns: the columns named in the "returned rows but drew nothing"
// notice.
//
// Untestable until now. It lived in the deck.gl layer compiler, which cannot be
// imported under tsx (@luma.gl/shadertools), so the ONLY function whose output a
// user reads while a map is failing had no coverage at all - and its binding
// reached render-map-inline across a package boundary, which a stale webpack
// cache reported as "not exported" (4 warnings, 0 on a clean build). Moved to
// inline-legend.ts, which is pure by construction, and asserted here.
chk('encoding cols: h3 names the hex AND the measure',
  JSON.stringify(encodingColumns(
    { type: 'h3', hexColumn: 'h3_cell', valueColumn: 'poi_count', data: { query: 'SELECT 1' } } as never,
  )) === '["h3_cell","poi_count"]');
chk('encoding cols: h3 without a measure names just the hex',
  JSON.stringify(encodingColumns(
    { type: 'h3', hexColumn: 'h3_cell', data: { query: 'SELECT 1' } } as never,
  )) === '["h3_cell"]');
chk('encoding cols: scatterplot names lng+lat',
  JSON.stringify(encodingColumns(
    { type: 'scatterplot', lng: 'lon', lat: 'lat', data: { query: 'SELECT 1' } } as never,
  )) === '["lon","lat"]');
chk('encoding cols: arc names all four',
  encodingColumns(
    { type: 'arc', source: { lng: 'a', lat: 'b' }, target: { lng: 'c', lat: 'd' }, data: { query: 'SELECT 1' } } as never,
  ).length === 4);
chk('encoding cols: a geojson path names the geometry column only',
  JSON.stringify(encodingColumns(
    { type: 'path', geojsonColumn: 'g', data: { query: 'SELECT 1' } } as never,
  )) === '["g"]');
chk('encoding cols: an endpoint path names its four coordinates',
  JSON.stringify(encodingColumns(
    { type: 'path', start: { lng: 'a', lat: 'b' }, end: { lng: 'c', lat: 'd' }, data: { query: 'SELECT 1' } } as never,
  )) === '["a","b","c","d"]');
// The notice interpolates `.join(', ')`, so a hole would print "a, , b" and read
// as a rendering bug in the very message explaining a rendering problem.
for (const [label, layer] of [
  ['a path missing one endpoint coordinate', {
    type: 'path', start: { lng: 'a' }, end: { lng: 'c', lat: 'd' }, data: { query: 'SELECT 1' },
  }],
  ['an h3 layer with no hexColumn (rejected upstream, but never crash here)', {
    type: 'h3', data: { query: 'SELECT 1' },
  }],
] as [string, unknown][]) {
  const cols = encodingColumns(layer as never);
  chk(`encoding cols: no empty entries for ${label}`,
    cols.every((c) => typeof c === 'string' && c.length > 0), JSON.stringify(cols));
}
// It must stay OUT of the compiler: putting it back reintroduces both the
// cross-package binding in an error path and the coverage hole. Reuses the
// compiler source the COMPILER_DEFAULTS drift check already read.
chk('encoding cols: not re-exported from the deck.gl compiler',
  !/^export function encodingColumns/m.test(compilerSrc));

// ---------------------------------------------------------------------------
// render_view column references: the same case defect as the map, in seven more
// agent-authorable components.
//
// parseDynamicSpec copies `data` wholesale and `config` as a permissive
// passthrough, so `mapping.metrics[].column`, `config.columns[].field`,
// `config.rowKey` and friends were never validated OR normalized. An UPPERCASE
// reference indexes a row key that /api/query has lowercased, so it matches
// nothing - and MetricCards / Chart then publish that placeholder into the
// agent's GROUNDING MEMO, which is worse than the blank map: the agent quotes a
// dash as a real value.
const area = (component: string, body: Record<string, unknown>) => {
  const spec = parseDynamicSpec(JSON.stringify({
    layout: { default: { grid: '"a"' } },
    areas: { a: { component, ...body } },
  }));
  if (!spec.ok) return { ok: false as const, errors: spec.errors };
  return { ok: true as const, area: spec.spec.areas.a as unknown as Record<string, any> };
};

const mc = area('MetricCards', {
  data: { query: 'SELECT 1', mapping: { metrics: [{ column: 'DWELL_MINUTES', label: 'Dwell Minutes' }] } },
});
chk('view refs: MetricCards column is lowercased',
  mc.ok && mc.area.data.mapping.metrics[0].column === 'dwell_minutes',
  mc.ok ? JSON.stringify(mc.area.data.mapping) : mc.errors.join('; '));
// The trap that dictated the whole design: `label` is a COLUMN name in
// ComboBox/FilterBar and DISPLAY TEXT here. A walker keyed on the NAME `label`
// would lowercase visible copy - trading a blank tile for corrupted wording.
chk('view refs: a MetricCards display label is NOT lowercased',
  mc.ok && mc.area.data.mapping.metrics[0].label === 'Dwell Minutes');

const ch = area('Chart', {
  data: { query: 'SELECT 1' },
  config: { xAxis: { field: 'CITY', fieldType: 'category' }, series: [{ type: 'bar', field: 'TRIPS', label: 'Trips', groupBy: 'VEHICLE_TYPE' }] },
});
chk('view refs: Chart xAxis/series/groupBy are lowercased',
  ch.ok && ch.area.config.xAxis.field === 'city'
  && ch.area.config.series[0].field === 'trips'
  && ch.area.config.series[0].groupBy === 'vehicle_type',
  ch.ok ? JSON.stringify(ch.area.config) : ch.errors.join('; '));
chk('view refs: a Chart series display label is NOT lowercased',
  ch.ok && ch.area.config.series[0].label === 'Trips');

const ct = area('ClickableTable', {
  data: { query: 'SELECT 1' },
  config: {
    rowKey: 'TRAILER_ID',
    columns: [{ field: 'TRAILER_ID', header: 'Trailer ID' }],
    defaultSort: { column: 'SAVINGS_EUR', direction: 'desc' },
    exceptionFirst: { column: 'STATUS', values: ['LATE'] },
  },
  emits: { selected_trailer: 'selection', selected_site: 'SITE_NAME' },
});
chk('view refs: ClickableTable rowKey + columns + sorts are lowercased',
  ct.ok && ct.area.config.rowKey === 'trailer_id'
  && ct.area.config.columns[0].field === 'trailer_id'
  && ct.area.config.defaultSort.column === 'savings_eur'
  && ct.area.config.exceptionFirst.column === 'status',
  ct.ok ? JSON.stringify(ct.area.config) : ct.errors.join('; '));
chk('view refs: a column HEADER is not lowercased', ct.ok && ct.area.config.columns[0].header === 'Trailer ID');
chk('view refs: an emit source column is lowercased', ct.ok && ct.area.emits.selected_site === 'site_name');
// 'selection'/'highlight' are sentinels resolved to config.rowKey, not columns.
chk('view refs: the selection SENTINEL survives untouched', ct.ok && ct.area.emits.selected_trailer === 'selection');
// exceptionFirst.values are row VALUES, not column names - lowercasing them would
// silently stop matching the data.
chk('view refs: exceptionFirst VALUES are untouched', ct.ok && ct.area.config.exceptionFirst.values[0] === 'LATE');

const cb = area('ComboBox', { data: { query: 'SELECT 1', mapping: { value: 'REGION', label: 'REGION_LABEL' } } });
chk('view refs: ComboBox mapping value AND label are lowercased (both ARE columns here)',
  cb.ok && cb.area.data.mapping.value === 'region' && cb.area.data.mapping.label === 'region_label',
  cb.ok ? JSON.stringify(cb.area.data.mapping) : cb.errors.join('; '));

// Emit normalization is scoped to the components that actually resolve an emit
// value against a ROW (ClickableTable). ComboBox and MetricCards read emit KEYS
// and ignore the values, so touching them would be a guess about a string nobody
// indexes a row with. Asserted so widening ROW_SOURCED_EMITS is a test failure
// rather than an invisible change of scope - without this the scoping claim in
// view-column-refs.ts is untestable, and a mutation that widened it passed.
const mcEmit = area('MetricCards', {
  data: { query: 'SELECT 1', mapping: { metrics: [{ column: 'TRIPS', label: 'Trips' }] } },
  emits: { selected_metric: 'Trips_Total' },
});
chk('view refs: an emit value on a NON-row-sourced component is untouched',
  mcEmit.ok && mcEmit.area.emits.selected_metric === 'Trips_Total',
  mcEmit.ok ? JSON.stringify(mcEmit.area.emits) : mcEmit.errors.join('; '));

const ed = area('EntityDetail', {
  data: { query: 'SELECT 1' },
  config: {
    entity: 'Trailer',
    pk_field: 'TRAILER_ID',
    name_field: 'TRAILER_NAME',
    parent_view: 'fleet',
    status_field: 'STATUS',
    subtitle_fields: ['CITY', 'DEPOT'],
    properties: [{ field: 'SAVINGS_EUR', label: 'Savings', id_field: 'SITE_ID' }],
    sections: [
      { type: 'text', field: 'NOTES' },
      { type: 'related_table', query: 'SELECT 1', columns: [{ field: 'LOAD_ID' }] },
    ],
    dependency_check: [{ field: 'SITE_ID', status_field: 'SITE_STATUS', name_field: 'SITE_NAME', version_field: 'SITE_VERSION', entity: 'Site', detail_view: 'site' }],
  },
});
chk('view refs: EntityDetail pk/name/status/subtitles are lowercased',
  ed.ok && ed.area.config.pk_field === 'trailer_id' && ed.area.config.name_field === 'trailer_name'
  && ed.area.config.status_field === 'status'
  && JSON.stringify(ed.area.config.subtitle_fields) === '["city","depot"]',
  ed.ok ? JSON.stringify(ed.area.config) : ed.errors.join('; '));
chk('view refs: EntityDetail properties + nested section columns are lowercased',
  ed.ok && ed.area.config.properties[0].field === 'savings_eur'
  && ed.area.config.properties[0].id_field === 'site_id'
  && ed.area.config.sections[0].field === 'notes'
  && ed.area.config.sections[1].columns[0].field === 'load_id');
chk('view refs: the dependency field that feeds /api/write record_id is lowercased',
  ed.ok && ed.area.config.dependency_check[0].field === 'site_id'
  && ed.area.config.dependency_check[0].status_field === 'site_status');
// `entity` is a manifest key and `parent_view`/`detail_view` are view ids - not
// columns, and lowercasing them would break the write gate and the navigation.
chk('view refs: the entity manifest key is NOT lowercased', ed.ok && ed.area.config.entity === 'Trailer');
chk('view refs: a dependency entity/detail_view is NOT lowercased',
  ed.ok && ed.area.config.dependency_check[0].entity === 'Site');

// Every component the verb accepts must be a deliberate decision: either it has
// paths or it is listed as having no column refs. Otherwise the next component
// added inherits the silent-blank-cell behaviour by default.
const classified = new Set<string>([...Object.keys(COLUMN_REF_PATHS), ...NO_COLUMN_REFS]);
const unclassified = VERB_RENDER_COMPONENTS.filter((c) => !classified.has(c));
chk('view refs: every agent-authorable component is classified',
  unclassified.length === 0, `unclassified: ${unclassified.join(', ')}`);

// The two allowlists are NOT the same set and must not be asserted equal. The
// verb list is what the AGENT may author; the client list is what the renderer
// supports, and it is a deliberate SUPERSET - authored dashboards in
// app-views.json use DetailPanel (6 areas) and Markdown (1), which the agent is
// intentionally not allowed to create. Two directions are worth holding:
//
//   1. verb SUBSET-OF client. view-spec-schema builds ALLOWED_COMPONENTS from
//      AREA_COMPONENT_NAMES, so a component the verb accepts but the client does
//      not is rejected at parse time: the agent is invited to author something
//      that always fails, and the error names an allowlist it cannot see.
const clientAllowed = new Set<string>(AREA_COMPONENT_NAMES);
const verbOnly = VERB_RENDER_COMPONENTS.filter((c) => !clientAllowed.has(c));
chk('view refs: every verb-authorable component is renderable by the client',
  verbOnly.length === 0, `verb-only (agent would author an unrenderable area): ${verbOnly.join(', ')}`);

//   2. every CLIENT component is classified, not just the verb's. Authored views
//      reach components the agent cannot author, and verify-app-views.mts holds
//      them to the same classification rule, so a client-only component with no
//      paths would fail that gate rather than this one - which is a confusing
//      place to discover it.
const clientUnclassified = AREA_COMPONENT_NAMES.filter((c) => !classified.has(c));
chk('view refs: every client-renderable component is classified',
  clientUnclassified.length === 0, `unclassified: ${clientUnclassified.join(', ')}`);

// ---------------------------------------------------------------------------
// GROUNDING: a wrong column must publish NOTHING, not a placeholder.
//
// The rendering half of the case defect is visible - a dash on a tile, an empty
// plot. The grounding half is not: MetricCards and Chart also publish to the
// agent memo, so `Label=-` and a series of NaNs reach the model as if they were
// measurements, and the agent quotes them. That is strictly worse than the blank
// map, which at least looked broken. Both builders are pure so this is testable
// without React; the guards were moved out of the components for exactly that.
chk('memo: a KPI whose column is absent is DROPPED, not published as a dash',
  buildKpiMemo({ trips: 42 }, [
    { column: 'trips', label: 'Trips', value: '42' },
    { column: 'DWELL_MINUTES', label: 'Dwell', value: '-' },
  ]) === 'Trips=42');
chk('memo: no matching columns at all means an EMPTY memo',
  buildKpiMemo({ trips: 42 }, [{ column: 'DWELL_MINUTES', label: 'Dwell', value: '-' }]) === '');
// A column that IS present and holds NULL is real data, and '-' is honest.
chk('memo: a present-but-NULL column is still reported',
  buildKpiMemo({ dwell: null }, [{ column: 'dwell', label: 'Dwell', value: '-' }]) === 'Dwell=-');
chk('memo: an empty row publishes nothing', buildKpiMemo(null, [{ column: 'a', label: 'A', value: '1' }]) === '');

const chartPoints = [{ city: 'SF', trips: 10 }, { city: 'LA', trips: 20 }];
chk('memo: a chart with matching columns still summarizes',
  buildChartMemo({ chartType: 'bar', xKey: 'city', yKey: 'trips', points: chartPoints }).includes('max'));
chk('memo: NEG an unmatched yKey publishes nothing (empty plot, non-empty points)',
  buildChartMemo({ chartType: 'bar', xKey: 'city', yKey: 'TRIPS', points: chartPoints }) === '');
chk('memo: NEG an unmatched xKey publishes nothing',
  buildChartMemo({ chartType: 'bar', xKey: 'CITY', yKey: 'trips', points: chartPoints }) === '');
// A grouped chart's yKey is a category VALUE synthesized per group, so it is not
// on the points by construction - checking it would silence every stacked chart.
chk('memo: a grouped chart is NOT silenced by its category yKey',
  buildChartMemo({
    chartType: 'stacked bar', xKey: 'city', yKey: 'ebike',
    points: [{ city: 'SF', ebike: 3 }], seriesNames: ['ebike'], yKeyIsColumn: false,
  }) !== '');

console.log(fails ? `\n${fails} FAILURE(S) of ${checks}` : `\nall ${checks} assertions passed`);
process.exit(fails ? 1 : 0);

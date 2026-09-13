// Regression test for the agent-emitted MAP spec validators (map-spec-schema.ts
// and, through it, the Map-area branch of view-spec-schema.ts).
//
// Run with: npx tsx verify_map_spec.mts   (from fleet_tools/user)
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
import { parseMapSpec, validateMapLayers, MAX_MAP_LAYERS } from '../../fleet_sa_app/ui/src/lib/map-spec-schema';
import { parseDynamicSpec } from '../../fleet_sa_app/ui/src/lib/view-spec-schema';

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

console.log(fails ? `\n${fails} FAILURE(S) of ${checks}` : `\nall ${checks} assertions passed`);
process.exit(fails ? 1 : 0);

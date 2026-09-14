// Regression test for the inline chart pipeline: payload -> specs -> themed ->
// compiled Vega.
//
// Run with (from fleet_sa_app/ui):
//   npx tsx scripts/verify-chart-spec.mts
//
// It lives HERE, not in fleet_tools/user alongside verify_map_spec.mts, for one
// reason: it needs `vega-lite`'s compiler, and node resolves that by walking up
// from the importing file. Only the SA app's node_modules carries vega-lite, and
// carrying a SECOND copy in fleet_tools would let the harness compile against a
// different version than the one that actually ships. `tsx` is a devDependency
// of this app for the same reason (running npx tsx here used to block on an
// interactive install prompt).
//
// WHAT IT PROTECTS. Every failure mode of an agent chart is silent:
//   - an unregistered tool name falls through to a collapsed JSON viewer, which
//     is exactly how this shipped for months;
//   - a spec that compiles to ZERO marks paints an empty box, indistinguishable
//     from "the query matched no rows" - so mark count is asserted, not assumed;
//   - a theme merged the wrong way round still draws, just not as the agent
//     asked, so the merge DIRECTION is asserted on real values;
//   - an unhandled `<chart>ID</chart>` citation is swallowed by react-markdown
//     without trace, leaving the chart above the prose instead of beside it.
//
// Fixtures come from ../app/fixtures/chart-specs.json; case 1 is verbatim from a
// live turn.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { compile } from 'vega-lite';
import { extractChartSpecs, sizeSpec, rowsOfSpec } from '../src/lib/chart-spec';
import { themeSpec, buildVegaTheme, mergeThemeUnder } from '../src/lib/vega-theme';
import { resolveChartCitations, stripCitationTags } from '../src/lib/chart-citations';
import { CHART_TOOL_NAME, CHART_TOOL_ALIASES, isChartTool } from '../src/lib/tool-names';
import { parseCortexStream } from '../src/lib/cortex-stream';
import { isSuppressedResult, attributeTool } from '../src/lib/tool-visibility';
import { DEFAULT_CHART_PALETTE } from '../src/lib/style-config';
import type { MessagePart } from '../src/lib/types';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.resolve(HERE, '../../app/fixtures/chart-specs.json');

let passed = 0;
const failures: string[] = [];

function check(label: string, cond: boolean, detail = ''): void {
  if (cond) { passed++; return; }
  failures.push(`${label}${detail ? ` - ${detail}` : ''}`);
}

/** Leaf marks in a compiled Vega spec. `group` marks are containers (layers,
 *  facets), so counting them would let an empty layered chart pass. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function countMarks(node: any): number {
  const marks = Array.isArray(node?.marks) ? node.marks : [];
  let n = 0;
  for (const m of marks) {
    if (m?.type === 'group') n += countMarks(m);
    else n++;
  }
  return n;
}

// ---------------------------------------------------------------- tool names
check('CHART_TOOL_NAME is the measured host name', CHART_TOOL_NAME === 'data_to_chart', CHART_TOOL_NAME);
check('aliases include the legacy render_chart', CHART_TOOL_ALIASES.includes('render_chart'));
check('isChartTool matches the bare host name', isChartTool('data_to_chart'));
// An MCP-namespaced chart tool would arrive prefixed; the separator is ONE
// underscore (see tool-names.ts), which is what defeated the old exact lookup.
check('isChartTool tolerates a server prefix', isChartTool('some_mcp_data_to_chart'));
check('isChartTool rejects an unrelated tool', !isChartTool('backload_solve'));
check('isChartTool rejects undefined', !isChartTool(undefined));

// ------------------------------------------------------------------ fixtures
const fixtures = JSON.parse(readFileSync(FIXTURES, 'utf8')) as {
  cases: Array<{ name: string; expectSpecs: number; expectMarks: number; payload: unknown }>;
  rejectCases: Array<{ name: string; payload: unknown }>;
};

for (const c of fixtures.cases) {
  const bundle = extractChartSpecs(c.payload);
  check(`[${c.name}] extracts ${c.expectSpecs} spec(s)`,
    bundle.specs.length === c.expectSpecs, `got ${bundle.specs.length}`);
  check(`[${c.name}] no extraction complaint`, bundle.reason === undefined, bundle.reason ?? '');

  for (const [i, spec] of bundle.specs.entries()) {
    let marks = -1;
    let err = '';
    try {
      const prepared = sizeSpec(themeSpec(spec, DEFAULT_CHART_PALETTE), 260);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      marks = countMarks(compile(prepared as any).spec);
    } catch (e) {
      err = (e as Error).message;
    }
    check(`[${c.name}] spec ${i} compiles`, err === '', err);
    check(`[${c.name}] spec ${i} draws >= ${c.expectMarks} mark(s)`,
      marks >= c.expectMarks, `got ${marks}`);
  }
}

for (const c of fixtures.rejectCases) {
  const bundle = extractChartSpecs(c.payload);
  check(`[reject: ${c.name}] yields no spec`, bundle.specs.length === 0);
  check(`[reject: ${c.name}] explains why`, typeof bundle.reason === 'string' && bundle.reason.length > 0);
}

// ------------------------------------------------- rows for the fallback path
// A chart that cannot be drawn must show its data instead of an empty card, so
// the rows have to be recoverable from the spec itself.
{
  const live = extractChartSpecs(fixtures.cases[0].payload);
  const rows = rowsOfSpec(live.specs[0]);
  check('live fixture yields fallback rows', rows.length === 8, `got ${rows.length}`);
  check('fallback rows carry the SQL column names',
    Object.prototype.hasOwnProperty.call(rows[0] ?? {}, 'FACILITY_TYPE'));
}

// ------------------------------------------------------------ theme direction
{
  const theme = buildVegaTheme(DEFAULT_CHART_PALETTE);
  // The live fixture's server template sets titleFontSize 14; the theme sets 13.
  // The SPEC must win, or the app silently overrides the server-side template.
  const merged = mergeThemeUnder({ title: { fontSize: 14 } }, theme) as
    { title: Record<string, unknown> };
  check('spec value wins over theme', merged.title.fontSize === 14, String(merged.title.fontSize));
  check('theme fills what the spec omits', merged.title.font === 'sans-serif', String(merged.title.font));

  // Explicit null is meaningful in Vega-Lite (`sort: null`) and must survive.
  const nulled = mergeThemeUnder({ view: { stroke: '#000' }, sort: null }, theme) as
    Record<string, unknown>;
  check('explicit null in the spec survives the merge', nulled.sort === null);

  // A spec array replaces the theme's wholesale rather than inheriting a tail.
  const ranged = mergeThemeUnder(
    { range: { category: ['#111', '#222'] } }, theme,
  ) as { range: { category: string[] } };
  check('a spec array replaces the theme array',
    ranged.range.category.length === 2, String(ranged.range.category.length));

  // Single-series marks must be themed: the live turn's color_mapping reported
  // Vega's stock #4c78a8 because a lone bar has no color channel for the
  // palette range to apply to.
  const themed = themeSpec({ mark: 'bar' }, DEFAULT_CHART_PALETTE) as
    { config: { bar: { fill: string } } };
  check('single-series bar takes the palette head',
    themed.config.bar.fill === DEFAULT_CHART_PALETTE[0], themed.config.bar.fill);
}

// ------------------------------------------------------------------- sizing
{
  const sized = sizeSpec({ mark: 'bar' }, 260) as Record<string, unknown>;
  check('width becomes container', sized.width === 'container');
  check('height is applied', sized.height === 260);
  // A spec that sets its own size keeps it.
  const kept = sizeSpec({ mark: 'bar', width: 400 }, 260) as Record<string, unknown>;
  check('an explicit width is not overwritten', kept.width === 400);
  // Multi-view specs reject a container width, so they must be left untouched
  // and allowed to fail their own compile into the table fallback.
  const faceted = sizeSpec({ facet: { field: 'A' }, spec: {} }, 260) as Record<string, unknown>;
  check('a faceted spec is left unsized', faceted.width === undefined);
}

// --------------------------------------------------------------- citations
{
  const chart = (id: string): MessagePart =>
    ({ type: 'tool_result', toolName: 'data_to_chart', output: { charts: [] }, toolUseId: id });

  // The shape of a real turn: the tool result arrives BEFORE the prose.
  const parts: MessagePart[] = [
    chart('tooluse_A'),
    { type: 'text', content: 'Restaurant dominates.\n\n<chart>tooluse_A</chart>\n\nMore prose.' },
  ];
  const out = resolveChartCitations(parts);
  const chartAt = out.findIndex((p) => p.type === 'tool_result');
  const firstText = out.findIndex((p) => p.type === 'text');
  check('cited chart moves after the prose that cites it', chartAt > firstText,
    `chart@${chartAt} text@${firstText}`);
  check('the citation tag is gone',
    !out.some((p) => p.type === 'text' && p.content.includes('<chart>')));
  check('prose on both sides of the citation is kept',
    out.filter((p) => p.type === 'text').length === 2);

  // An UNMATCHED citation must not drop the chart - the failure mode of this
  // feature is "wrong position", never "missing chart".
  const orphan = resolveChartCitations([
    chart('tooluse_A'),
    { type: 'text', content: 'See <chart>tooluse_MISSING</chart> here.' },
  ]);
  check('an unmatched citation still renders the chart',
    orphan.some((p) => p.type === 'tool_result'));
  check('an unmatched citation tag is still stripped',
    !orphan.some((p) => p.type === 'text' && p.content.includes('<chart>')));

  // A host that sends no ids at all: positional rendering, tags stripped.
  const noIds = resolveChartCitations([
    { type: 'tool_result', toolName: 'data_to_chart', output: { charts: [] } },
    { type: 'text', content: 'Prose <chart>tooluse_A</chart>.' },
  ]);
  check('a chart with no id is preserved', noIds.some((p) => p.type === 'tool_result'));
  check('tags stripped even with no ids',
    !noIds.some((p) => p.type === 'text' && p.content.includes('<chart>')));

  // Two charts, two citations, order preserved.
  const two = resolveChartCitations([
    chart('one'), chart('two'),
    { type: 'text', content: 'A <chart>one</chart> then B <chart>two</chart> end.' },
  ]);
  const ids = two.filter((p) => p.type === 'tool_result')
    .map((p) => (p as { toolUseId?: string }).toolUseId);
  check('two citations resolve in order', ids.join(',') === 'one,two', ids.join(','));

  // Non-chart tool results must be untouched by any of this.
  const other = resolveChartCitations([
    { type: 'tool_result', toolName: 'render_map', output: {}, toolUseId: 'm1' },
    { type: 'text', content: 'map above' },
  ]);
  check('a non-chart tool result keeps its position', other[0].type === 'tool_result');

  check('stripCitationTags removes map and table tags too',
    stripCitationTags('a<map>x</map>b<table>y</table>c') === 'abc');
  check('stripCitationTags leaves ordinary prose alone',
    stripCitationTags('2 < 3 and 4 > 1') === '2 < 3 and 4 > 1');
}

// -------------------------------------------------------------- stream dedupe
// The host sends the SAME chart twice: as a `data_to_chart` tool_result and as a
// `response.chart` event. Measured in SEMANTIC_OPS.AGENT_TURN.TOOLS_USED, where
// one turn records `data_to_chart, render_table, render_chart`. Harmless while
// neither path rendered; now that both names are registered it would draw the
// chart twice, and a duplicated chart raises no error anywhere.
{
  const spec = JSON.stringify({
    mark: 'bar',
    data: { values: [{ K: 'a', V: 1 }] },
    encoding: { x: { field: 'V', type: 'quantitative' }, y: { field: 'K', type: 'nominal' } },
  });
  const sse = [
    `event: response.tool_result\ndata: ${JSON.stringify({
      name: 'data_to_chart', tool_use_id: 'tooluse_X',
      content: [{ type: 'json', json: { charts: [spec] } }],
    })}`,
    `event: response.text.delta\ndata: ${JSON.stringify({ text: 'Prose <chart>tooluse_X</chart>.' })}`,
    `event: response.chart\ndata: ${JSON.stringify({ chart_spec: spec })}`,
    'event: response\ndata: {}',
  ].join('\n\n') + '\n\n';

  const body = new Response(new TextEncoder().encode(sse));
  const parts: MessagePart[] = [];
  await parseCortexStream(body, {
    onPart: (p) => parts.push(p),
    onStatus: () => {},
    onMetadata: () => {},
    onError: (e) => failures.push(`stream error: ${e}`),
    onDone: () => {},
  });

  const chartParts = parts.filter(
    (p) => p.type === 'tool_result' && isChartTool(p.toolName));
  check('the duplicated chart is emitted ONCE', chartParts.length === 1,
    `got ${chartParts.length}`);
  check('the surviving chart part carries the tool_use_id',
    chartParts[0]?.type === 'tool_result' && chartParts[0].toolUseId === 'tooluse_X',
    String((chartParts[0] as { toolUseId?: string } | undefined)?.toolUseId));

  // ...and it still resolves to the citation position, end to end.
  const resolved = resolveChartCitations(parts);
  const ci = resolved.findIndex((p) => p.type === 'tool_result');
  const ti = resolved.findIndex((p) => p.type === 'text');
  check('end to end: chart lands after its prose', ci > ti && ti >= 0, `chart@${ci} text@${ti}`);

  // A host that sends ONLY response.chart must still render.
  const only = new Response(new TextEncoder().encode(
    `event: response.chart\ndata: ${JSON.stringify({ chart_spec: spec })}\n\n`));
  const soloParts: MessagePart[] = [];
  await parseCortexStream(only, {
    onPart: (p) => soloParts.push(p),
    onStatus: () => {}, onMetadata: () => {},
    onError: (e) => failures.push(`solo stream error: ${e}`), onDone: () => {},
  });
  check('response.chart alone still produces a chart',
    soloParts.filter((p) => p.type === 'tool_result' && isChartTool(p.toolName)).length === 1);
}

// ------------------------------------------------- tool visibility + attribution
// The other three JSON blobs from the same turn. Each was an unhandled tool name:
// a legal, silent state that renders as a tidy collapsed row.
{
  // An analyst result is recognised by SHAPE, so a NEW query_* tool is covered on
  // the day it is added. A name list (13 today) would go stale silently, which is
  // the defect being fixed - the old code keyed on the tool TYPE
  // `cortex_analyst_text_to_sql` while the stream sends `query_dwell`.
  check('an analyst tool is NOT suppressed by its name alone',
    !isSuppressedResult('query_dwell', { rows: [] }));
  check('an analyst semantic-model payload IS suppressed',
    isSuppressedResult('query_dwell', {
      semantic_model_key: 'query_dwell',
      semantic_view_fqn: 'FLEET_INTELLIGENCE.SEMANTIC.SV_DWELL_ANALYTICS',
      sql_best_practices: '...', tables: [],
    }));
  check('a NEW analyst tool is covered with no code edit',
    isSuppressedResult('query_something_new_2027', { semantic_model_key: 'x' }));
  check('the tool TYPE still suppresses, for a host that sends it',
    isSuppressedResult('cortex_analyst_text_to_sql', {}));

  check('the host SQL executor envelope is suppressed',
    isSuppressedResult('system_execute_sql', {
      query_id: '01c7', sql: 'SELECT 1', result_set: { data: [] },
    }));
  // Shape alone is enough, so a renamed executor is still covered.
  check('a SQL envelope is suppressed on shape alone',
    isSuppressedResult('some_other_executor', { sql: 'SELECT 1', result_set: {} }));

  // Not suppressed: server_skill renders as a chip, and an ordinary verb result
  // must still be visible.
  check('server_skill is NOT suppressed (it renders as a chip)',
    !isSuppressedResult('server_skill', { skill_name: 'dwell-facilities', content: '# ...' }));
  check('an ordinary verb result is not suppressed',
    !isSuppressedResult('routing_mcp_get_directions', { distance: 12 }));
  check('a chart result is not suppressed',
    !isSuppressedResult('data_to_chart', { charts: ['{}'] }));

  // Attribution: TOOLS_USED must say WHICH skill fired. Without this the turn
  // record proves only that A skill fired, which is why "did the agent select the
  // CoWork skill" could not be answered from SQL.
  check('server_skill is attributed to its skill',
    attributeTool('server_skill', { skill_name: 'dwell-facilities' })
      === 'server_skill:dwell-facilities');
  check('attribution tolerates the MCP prefix',
    attributeTool('x_mcp_server_skill', { skill_name: 'a' }) === 'x_mcp_server_skill:a');
  check('a skill with no name degrades to the bare tool name',
    attributeTool('server_skill', { content: '# ...' }) === 'server_skill');
  check('a non-skill tool is never rewritten',
    attributeTool('query_dwell', { skill_name: 'nope' }) === 'query_dwell');
  check('the attributed name stays bounded',
    attributeTool('server_skill', { skill_name: 'z'.repeat(500) }).length <= 'server_skill:'.length + 60);
  // Existing queries filter on the bare name, so the prefix must survive STARTSWITH.
  check('the attributed name still starts with the tool name',
    attributeTool('server_skill', { skill_name: 'a' }).startsWith('server_skill'));
}

// -------------------------------------------------------------------- report
console.log(`${passed} assertion(s) passed`);
if (failures.length) {
  console.error(`\nFAILED ${failures.length} assertion(s):`);
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}
console.log('PASSED: chart payloads extract, theme correctly, compile with marks, and cite in place');

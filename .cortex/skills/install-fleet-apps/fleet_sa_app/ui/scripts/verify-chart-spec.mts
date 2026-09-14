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

// -------------------------------------------------------------------- report
console.log(`${passed} assertion(s) passed`);
if (failures.length) {
  console.error(`\nFAILED ${failures.length} assertion(s):`);
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}
console.log('PASSED: chart payloads extract, theme correctly, compile with marks, and cite in place');

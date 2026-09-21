// Normalizing a Cortex `data_to_chart` tool result into Vega-Lite specs.
//
// Pure, dependency-free and separate from the React component so the harness
// (fleet_tools/user/verify_chart_spec.mts) can drive it from node against real
// captured payloads - a chart that renders blank in production must be
// convictable without a browser.
//
// PAYLOAD SHAPE, MEASURED from a live turn:
//     { "charts": [ "{\"mark\":\"bar\",\"encoding\":{...},\"data\":{\"values\":[...]}}" ] }
// An ARRAY of spec STRINGS. Two things follow that the previous single-spec
// reader got wrong: the key is `charts` (not `chartSpec`), and there can be more
// than one - the host chart skill explicitly instructs the agent to call
// data_to_chart repeatedly when one chart would be misleading, so returning only
// the first would silently drop half an answer.
//
// Data is already inlined at `data.values` by the host (it injects the
// referenced SQL result before streaming), so nothing here needs to fetch rows.

export type ChartRow = Record<string, unknown>;

export interface ChartSpecBundle {
  /** Specs to render, in the order the agent emitted them. */
  specs: Record<string, unknown>[];
  /** Why nothing (or not everything) could be read, for on-screen display. */
  reason?: string;
  /** Inline rows recovered from the payload, so an unrenderable chart can still
   *  show its data instead of becoming an empty card. */
  rows: ChartRow[];
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Parse a spec that may arrive as a JSON string or as an object. */
function coerceSpec(raw: unknown): Record<string, unknown> | string {
  if (isPlainObject(raw)) return raw;
  if (typeof raw === 'string') {
    const text = raw.trim();
    if (!text.startsWith('{')) return 'chart spec is not a JSON object';
    try {
      const parsed = JSON.parse(text);
      if (isPlainObject(parsed)) return parsed;
      return 'chart spec did not parse to an object';
    } catch (e) {
      return `chart spec is not valid JSON: ${(e as Error).message}`;
    }
  }
  return 'chart spec is missing';
}

/** Inline rows from a spec's top-level `data.values`, for the fallback table. */
export function rowsOfSpec(spec: Record<string, unknown>): ChartRow[] {
  const data = spec.data;
  const values = isPlainObject(data) ? data.values : undefined;
  return Array.isArray(values) ? (values as unknown[]).filter(isPlainObject) : [];
}

/** Keys that make an object recognisably a Vega-Lite spec. Needed because the
 *  last resort below treats the whole payload AS a spec, and without this test
 *  an unrelated envelope (an error object, a `{status:'ok'}` ack) would be
 *  accepted as one and then fail deep inside the compiler with a message that
 *  says nothing about what actually arrived. */
const SPEC_MARKERS = [
  'mark', 'layer', 'encoding', 'facet', 'repeat', 'concat', 'hconcat', 'vconcat', '$schema',
] as const;

function looksLikeSpec(v: Record<string, unknown>): boolean {
  return SPEC_MARKERS.some((k) => v[k] !== undefined);
}

/**
 * Read every Vega-Lite spec out of a chart tool result.
 *
 * Accepts, in order of how likely it is to be what the host sent:
 *   - `{ charts: [...] }`            the measured Cortex data_to_chart shape
 *   - `{ chartSpec | chart_spec | chart | spec: ... }`  single-spec variants
 *   - a bare spec object or JSON string
 */
export function extractChartSpecs(output: unknown): ChartSpecBundle {
  let payload: unknown = output;
  if (typeof payload === 'string') {
    const coerced = coerceSpec(payload);
    if (typeof coerced === 'string') return { specs: [], reason: coerced, rows: [] };
    payload = coerced;
  }
  if (!isPlainObject(payload)) {
    return { specs: [], reason: 'chart result is not an object', rows: [] };
  }

  const single = payload.chartSpec ?? payload.chart_spec ?? payload.chart ?? payload.spec;
  let raws: unknown[];
  if (Array.isArray(payload.charts)) {
    raws = payload.charts;
  } else if (single !== undefined) {
    raws = [single];
  } else if (looksLikeSpec(payload)) {
    raws = [payload];
  } else {
    return { specs: [], reason: 'chart result carried no spec', rows: [] };
  }

  const specs: Record<string, unknown>[] = [];
  const reasons: string[] = [];
  for (const raw of raws) {
    const coerced = coerceSpec(raw);
    if (typeof coerced === 'string') reasons.push(coerced);
    else specs.push(coerced);
  }

  const rows = specs.flatMap(rowsOfSpec);
  if (specs.length === 0) {
    return { specs, reason: reasons[0] ?? 'chart result carried no spec', rows };
  }
  // Partial failure still renders what parsed; the reason is shown alongside.
  return { specs, reason: reasons.length ? reasons.join('; ') : undefined, rows };
}

/**
 * Make a spec renderable in a chat bubble of unknown width.
 *
 * The host strips `width`/`height` from whatever the agent wrote (its own
 * instructions say those are set in post-processing), so a spec arrives with no
 * size at all and Vega falls back to a fixed 200px plot. `width: "container"`
 * plus `autosize: fit` makes it track the bubble.
 *
 * Set only when ABSENT, and skipped entirely for multi-view specs (`facet`,
 * `repeat`, `concat`), where Vega-Lite rejects a container width outright - such
 * a spec is left alone to fail its own compile and land in the table fallback,
 * rather than being mangled into a different error.
 */
export function sizeSpec(spec: Record<string, unknown>, height: number): Record<string, unknown> {
  const multiView = ['facet', 'repeat', 'concat', 'hconcat', 'vconcat']
    .some((k) => spec[k] !== undefined);
  if (multiView) return spec;
  const out = { ...spec };
  if (out.width === undefined) out.width = 'container';
  if (out.height === undefined) out.height = height;
  if (out.autosize === undefined) out.autosize = { type: 'fit', contains: 'padding' };
  return out;
}

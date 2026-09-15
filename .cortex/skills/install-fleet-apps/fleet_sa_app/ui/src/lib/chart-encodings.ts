/**
 * Why a chart drew nothing.
 *
 * A chart is the last surface that could render an empty frame in silence. Its
 * only empty state fires when there are no points at all, but a series bound to
 * a column the result set does not have still produces points - the row loop
 * copies every key verbatim - so recharts drew axes, no marks, and said nothing.
 * That is the same silence the maps used to have, and it reads as "no data
 * matched my filter" when it is really a column name that never matched.
 *
 * Checked against the RAW rows, not the derived points: a grouped chart's point
 * keys are category VALUES rather than columns, so the derived shape cannot tell
 * a missing column from a category that happens to be absent.
 *
 * Pure and recharts-free so it can be asserted directly.
 */

export interface ChartPlotInput {
  /** config.xAxis.field - the category/domain column. */
  xField: string;
  /** config.series[].field - the columns that give marks their value. */
  valueFields: string[];
  /** config.series[].groupBy when the chart is grouped - also a column. */
  groupBy?: string;
  /** The query result rows, before any per-point transformation. */
  rows: Record<string, unknown>[];
}

const present = (row: Record<string, unknown>, name: string): boolean =>
  typeof name === 'string' && name.length > 0 && name in row;

/**
 * Columns this chart reads. Mirrors the map's `encodingColumns`: the fix for a
 * blank chart is almost always one of these names, so they are what gets shown.
 */
export function chartEncodingColumns(input: Pick<ChartPlotInput, 'xField' | 'valueFields' | 'groupBy'>): string[] {
  return [input.xField, ...(input.valueFields ?? []), input.groupBy]
    .filter((c): c is string => typeof c === 'string' && c.length > 0);
}

/**
 * '' when the chart can draw, otherwise a sentence naming the columns it looked
 * for and the columns it actually got.
 *
 * Only reports when NO mark can be drawn. A chart missing its x column still
 * draws marks (against blank categories) and a chart missing SOME of several
 * series still draws the rest; calling those "undrawable" would be wrong, and a
 * notice that fires on a working chart is worse than none.
 */
export function chartPlotDiagnostic(input: ChartPlotInput): string {
  const rows = input.rows ?? [];
  if (!rows.length) return '';
  const first = rows[0];
  if (!first || typeof first !== 'object') return '';

  const values = (input.valueFields ?? []).filter((f): f is string => typeof f === 'string' && f.length > 0);
  // A grouped chart needs its groupBy column too - without it every row falls
  // into one blank category, which is a different failure than drawing nothing.
  const needed = input.groupBy ? [...values, input.groupBy] : values;
  if (!needed.length) return '';

  const anyValueDrawable = values.some((f) => present(first, f));
  const groupDrawable = !input.groupBy || present(first, input.groupBy);
  if (anyValueDrawable && groupDrawable) return '';

  const missing = needed.filter((f) => !present(first, f));
  const columns = Object.keys(first);
  return `${rows.length} rows, nothing plotted`
    + ` (no ${missing.join(', ')} in the result${columns.length ? `; columns are ${columns.join(', ')}` : ''})`;
}

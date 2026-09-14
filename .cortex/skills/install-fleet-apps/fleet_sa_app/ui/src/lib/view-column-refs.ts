// Lowercases the COLUMN REFERENCES inside an agent-emitted view area.
//
// WHY
// ---
// `/api/query` builds every row key as `col.name.toLowerCase()`
// (app/api/query/route.ts), unconditionally, on both the trusted and the dynamic
// path. Snowflake upper-cases an unquoted alias and that route then lowers it, so
// a row key is ALWAYS lowercase whatever the SQL said. Area components, though,
// index rows with the spec's string verbatim - `row[m.column]`, `row[c.field]`,
// `row[rowKey]` - so an UPPERCASE reference matches nothing.
//
// This is the same defect that drew an empty map with a correct legend (see
// map-spec-schema.ts normalizeColumnRefs), found in seven more components after
// that fix. `parseDynamicSpec` copies `data` wholesale and `config` as a
// permissive passthrough, so none of these were validated or normalized. The
// failures are silent and, in two cases, worse than silent:
//
//   MetricCards  every tile renders '-' AND `Label=-` is published into the
//                agent's grounding memo, so the agent quotes the dash as fact
//   Chart        an empty plot WITH axes (the chartData.length guard passes) and
//                an empty series in the memo
//   ClickableTable  blank cells under correct headers; an uppercase rowKey makes
//                every row click emit null, so sibling panels empty and the table
//                reads as unclickable
//   ComboBox     N blank options, each emitting ''
//   FilterBar    nothing seeds; the isBlocked guard checks options.length, which
//                is non-zero, so no warning ever fires and dependents bind NULL
//   EntityDetail an uppercase dependency `field` POSTs an empty record_id
//   AutoTable    blank cells under correct headers
//
// The agent is not being careless: render_view's own description teaches
// UPPERCASE names (F_FACT_*_SCOPED, VW_*), exactly as render_map's taught
// H3_CELL_R7. So normalize, do not reject.
//
// WHY EXPLICIT PATHS AND NOT A KEY-NAME WALK
// ------------------------------------------
// Because `label` is a column name in ComboBox/FilterBar (`data.mapping.label`)
// and DISPLAY TEXT everywhere else (`metrics[].label`, `config.label`,
// `properties[].label`). A walker that lowercased every key called `label` would
// silently lower-case visible UI text - trading a blank cell for corrupted
// copy. Same for `value`. So this is default-DENY by PATH: a reference is
// normalized only where a component is known to index a row with it.
//
// Paths are relative to the area object `{data, config, emits}` and use `[]` for
// "every element of this array". Only STRING leaves are touched.
//
// KNOWN LIMITATION: THIS LIST IS MANUAL AT FIELD LEVEL
// ----------------------------------------------------
// The test suite asserts every agent-authorable COMPONENT appears here or in
// NO_COLUMN_REFS, so a new component cannot be forgotten. It does NOT assert that
// every column-bearing FIELD of a listed component is covered. Add a `groupBy` to
// ClickableTable's config, or a second `id_field` to DetailPanel, and it silently
// misses normalization - the same blank-render-no-error failure as the original
// defect, in a component that looks protected.
//
// So: when you add a prop that gets used to index a row (`row[x]`, `r[x]`,
// `point[x]`), add its path here in the same commit. Closing this properly means
// diffing each component's prop types against these paths, which is more
// machinery than the current risk justifies - but it is the reason a passing test
// run is not proof that a NEW field is normalized.

/** Areas whose config/data carry no row-column reference at all.
 *
 *  `Table` reads `row[col.key]` from the response METADATA (inherently correct)
 *  and its `rowClick.idField` sits on `areaConfig.rowClick`, which
 *  parseDynamicSpec does not copy. `Map` is handled by normalizeColumnRefs in
 *  map-spec-schema.ts. Slider indexes positionally; Checkbox has no columns.
 *  Listed rather than defaulted so a new component is a deliberate decision. */
export const NO_COLUMN_REFS = ['Table', 'Slider', 'Checkbox', 'Markdown', 'Map'] as const;

/**
 * Column-reference paths per component.
 *
 * FilterBar note: its per-filter mappings live on `areaConfig.filters`, which
 * parseDynamicSpec does NOT copy, so only the `data.queries` form is reachable
 * from an agent spec. Both are listed anyway - the unreachable one costs nothing
 * and stops being a trap if the copy list ever widens.
 */
export const COLUMN_REF_PATHS: Record<string, readonly string[]> = {
  MetricCards: ['data.mapping.metrics[].column'],
  Chart: ['config.xAxis.field', 'config.series[].field', 'config.series[].groupBy'],
  ClickableTable: [
    'config.rowKey',
    'config.columns[].field',
    'config.defaultSort.column',
    'config.exceptionFirst.column',
  ],
  ComboBox: ['data.mapping.value', 'data.mapping.label'],
  FilterBar: [
    'data.queries.*.mapping.value',
    'data.queries.*.mapping.label',
    'filters[].data.mapping.value',
    'filters[].data.mapping.label',
  ],
  EntityDetail: [
    'config.pk_field',
    'config.name_field',
    'config.status_field',
    'config.subtitle_fields[]',
    'config.properties[].field',
    'config.properties[].id_field',
    'config.sections[].field',
    'config.sections[].columns[].field',
    'config.dependency_check[].field',
    'config.dependency_check[].status_field',
    'config.dependency_check[].name_field',
    'config.dependency_check[].version_field',
  ],
  DetailPanel: [
    'config.titleField',
    'config.subtitleFields[]',
    'config.properties[].field',
    'config.properties[].id_field',
  ],
};

/** Emit sources that name a SENTINEL rather than a column, so they must survive
 *  untouched. ClickableTable resolves both to `config.rowKey`. */
const EMIT_SENTINELS = new Set(['selection', 'highlight']);

/** Components whose `emits` VALUES name a column on the clicked row.
 *
 *  Only ClickableTable resolves them that way (`patch[key] = row[source]`).
 *  ComboBox and MetricCards read emit KEYS and ignore the values entirely, so
 *  lowercasing there would be a guess about a field nobody indexes a row with -
 *  and this file is default-deny on purpose. Emit KEYS are viewState keys and are
 *  never touched. */
const ROW_SOURCED_EMITS = new Set(['ClickableTable']);

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

const lower = (v: unknown): unknown => (typeof v === 'string' ? v.toLowerCase() : v);

/**
 * Apply `lower` at `path` within `node`, REPLACING each container on the way
 * down rather than mutating it.
 *
 * Replacement is not stylistic: `parseDynamicSpec` copies `data` by REFERENCE
 * and `config` one level deep, so a nested object here can still belong to the
 * caller - and for an authored dashboard view that object belongs to the parsed,
 * cached app-views.json. Mutating it would rewrite the repo's own view
 * definitions in memory.
 */
function normalizeAt(node: unknown, segments: readonly string[]): unknown {
  if (segments.length === 0) return lower(node);
  const [head, ...rest] = segments;

  if (head === '[]') {
    if (!Array.isArray(node)) return node;
    return node.map((el) => normalizeAt(el, rest));
  }
  if (head === '*') {
    if (!isObj(node)) return node;
    const out: Record<string, unknown> = { ...node };
    for (const k of Object.keys(out)) out[k] = normalizeAt(out[k], rest);
    return out;
  }
  if (!isObj(node) || !(head in node)) return node;
  return { ...node, [head]: normalizeAt(node[head], rest) };
}

/** Split "config.series[].field" into ['config','series','[]','field']. */
function parsePath(path: string): string[] {
  const out: string[] = [];
  for (const raw of path.split('.')) {
    let seg = raw;
    while (seg.endsWith('[]')) {
      seg = seg.slice(0, -2);
      if (seg) out.push(seg);
      out.push('[]');
      seg = '';
    }
    if (seg) out.push(seg);
  }
  return out;
}

/**
 * Return a copy of `area` with every known column reference lowercased.
 *
 * Unknown components are returned unchanged: this is default-deny, so adding a
 * component means adding its paths (or listing it in NO_COLUMN_REFS).
 */
export function normalizeAreaColumnRefs<T extends Record<string, unknown>>(
  component: string,
  area: T,
): T {
  let out: unknown = area;
  for (const path of COLUMN_REF_PATHS[component] ?? []) {
    out = normalizeAt(out, parsePath(path));
  }
  // Emit sources name columns on the clicked row, except for the two sentinels.
  const emits = (out as Record<string, unknown>).emits;
  if (ROW_SOURCED_EMITS.has(component) && isObj(emits)) {
    const nextEmits: Record<string, unknown> = { ...emits };
    let changed = false;
    for (const [k, v] of Object.entries(nextEmits)) {
      if (typeof v === 'string' && !EMIT_SENTINELS.has(v)) {
        const lowered = v.toLowerCase();
        if (lowered !== v) changed = true;
        nextEmits[k] = lowered;
      }
    }
    if (changed) out = { ...(out as Record<string, unknown>), emits: nextEmits };
  }
  return out as T;
}

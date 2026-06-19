// Pure (React-free) runtime helpers for the declarative page-spec system:
//   - binding scope + dot-path resolution
//   - `:param` -> SQL-literal interpolation for DataSourceSpec
//   - structural validation of a PageSpec (registry-aware)
//
// Kept dependency-free so it ports to the SA image alongside spec-types.

import type { DataSourceSpec, PageSpec, AreaSpec } from './spec-types';

// ---------------------------------------------------------------------------
// Binding scope
// ---------------------------------------------------------------------------

/** Region context projected into a plain object for spec binding. */
export interface RegionScope {
  regionName: string;
  displayName: string;
  center: { lat: number; lng: number };
  zoom: number;
  boundaryGeoJson: string | null;
}

export interface VehicleScope {
  vehicleType: string;
  activeDatasetId?: string | null;
}

/** The scope a spec's `params` / `:placeholders` resolve against. */
export interface BindingScope {
  region: RegionScope;
  vehicle: VehicleScope;
  viewState: Record<string, unknown>;
}

/** Resolve a dot-path (e.g. "viewState.selectedStatus") against a scope. */
export function resolvePath(scope: BindingScope, path: string): unknown {
  const parts = path.split('.');
  let cur: unknown = scope;
  for (const p of parts) {
    if (cur == null || typeof cur !== 'object') return undefined;
    cur = (cur as Record<string, unknown>)[p];
  }
  return cur;
}

// ---------------------------------------------------------------------------
// SQL literal encoding + param interpolation
// ---------------------------------------------------------------------------

/**
 * Encode a JS value as a Snowflake SQL literal. String escaping doubles single
 * quotes. Values come from builder-authored specs and DISTINCT-value filter
 * queries (same trust model as SA), not arbitrary end-user free text.
 */
export function toSqlLiteral(value: unknown): string {
  if (value == null) return 'NULL';
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : 'NULL';
  if (typeof value === 'boolean') return value ? 'TRUE' : 'FALSE';
  const s = String(value).replace(/'/g, "''");
  return `'${s}'`;
}

/**
 * Replace `:name` placeholders in `ds.query` with resolved SQL literals.
 * Unmatched/undefined params resolve to NULL. Returns the final SQL string.
 *
 * Placeholders must be word-boundaried (`:name`) and are matched longest-first
 * to avoid `:foo` partially matching `:foobar`.
 */
export function buildQuery(ds: DataSourceSpec, scope: BindingScope): string {
  if (!ds.params) return ds.query;
  const names = Object.keys(ds.params).sort((a, b) => b.length - a.length);
  let sql = ds.query;
  for (const name of names) {
    const path = ds.params[name];
    const literal = toSqlLiteral(resolvePath(scope, path));
    sql = sql.replace(new RegExp(`:${name}\\b`, 'g'), literal);
  }
  return sql;
}

// ---------------------------------------------------------------------------
// Grid parsing + validation
// ---------------------------------------------------------------------------

/** Extract the unique area tokens from a CSS grid-template-areas string. */
export function gridTokens(grid: string): string[] {
  const tokens = new Set<string>();
  for (const raw of grid.split('\n')) {
    const line = raw.replace(/"/g, ' ').trim();
    if (!line) continue;
    for (const t of line.split(/\s+/)) {
      if (t && t !== '.') tokens.add(t);
    }
  }
  return [...tokens];
}

const KNOWN_COMPONENTS = new Set(['MetricCards', 'Chart', 'Table', 'FilterBar', 'ComboBox', 'Map']);

/**
 * Validate a PageSpec structurally. `registryKeys` is the set of component
 * strings the renderer can resolve (built-ins plus any registered custom
 * full-page components). Returns a list of human-readable errors; empty = valid.
 */
export function validatePageSpec(spec: PageSpec, registryKeys: ReadonlySet<string>): string[] {
  const errors: string[] = [];

  if (!spec.id) errors.push('PageSpec.id is required');
  if (!spec.layout || !spec.layout.default) {
    errors.push('PageSpec.layout.default is required');
  }
  if (!spec.areas || Object.keys(spec.areas).length === 0) {
    errors.push('PageSpec.areas must define at least one area');
  }

  // Every grid token must map to an area; warn on areas never placed.
  if (spec.layout?.default?.grid && spec.areas) {
    const tokens = gridTokens(spec.layout.default.grid);
    for (const tok of tokens) {
      if (!spec.areas[tok]) {
        errors.push(`layout grid references area "${tok}" which is not defined in areas`);
      }
    }
    for (const name of Object.keys(spec.areas)) {
      if (!tokens.includes(name)) {
        errors.push(`area "${name}" is defined but never placed in the default grid`);
      }
    }
  }

  // Component keys must resolve, and required per-type fields must exist.
  for (const [name, area] of Object.entries(spec.areas ?? {})) {
    if (!area.component) {
      errors.push(`area "${name}" is missing a component`);
      continue;
    }
    const isBuiltin = KNOWN_COMPONENTS.has(area.component);
    if (!isBuiltin && !registryKeys.has(area.component)) {
      errors.push(`area "${name}" uses unknown component "${area.component}"`);
    }
    errors.push(...validateArea(name, area));
  }

  return errors;
}

function validateArea(name: string, area: AreaSpec): string[] {
  const errs: string[] = [];
  switch (area.component) {
    case 'MetricCards':
      if (!('data' in area) || !area.data?.query) errs.push(`MetricCards "${name}" needs data.query`);
      if (!('mapping' in area) || !area.mapping?.metrics?.length) errs.push(`MetricCards "${name}" needs mapping.metrics`);
      break;
    case 'Chart':
      if (!('data' in area) || !area.data?.query) errs.push(`Chart "${name}" needs data.query`);
      if (!('config' in area) || !area.config?.chartType) errs.push(`Chart "${name}" needs config.chartType`);
      if ('config' in area && !area.config?.series?.length) errs.push(`Chart "${name}" needs config.series`);
      break;
    case 'Table':
      if (!('data' in area) || !area.data?.query) errs.push(`Table "${name}" needs data.query`);
      break;
    case 'Map':
      if (!('layers' in area) || !area.layers?.length) errs.push(`Map "${name}" needs at least one layer`);
      break;
    case 'FilterBar':
      if (!('filters' in area) || !area.filters?.length) errs.push(`FilterBar "${name}" needs filters`);
      break;
    case 'ComboBox':
      if (!('filter' in area) || !area.filter) errs.push(`ComboBox "${name}" needs a filter`);
      break;
    default:
      // Custom full-page component: no structural requirements here.
      break;
  }
  return errs;
}

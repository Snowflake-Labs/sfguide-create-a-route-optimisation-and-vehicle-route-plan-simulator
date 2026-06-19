// SA-aligned declarative page-spec types.
//
// These shapes deliberately mirror Solution Accelerator's view schema so that a
// PageSpec authored here can be translated to an SA `views/*.yaml` almost
// mechanically in Step 2 of the migration:
//   - `layout.default.{columns,rows,grid}`  == SA layout.default
//   - `areas[name].component`               == SA area component string
//   - `areas[name].data.{query,params,mapping}` == SA area data block
//
// The one concept SA lacks today is `LayerSpec` (the deck.gl map DSL). It is
// defined here so the Map area component (Step 1, task 4) and the SA Map area
// (Step 2) can share the exact same layer model.
//
// This module intentionally imports nothing from React or deck.gl: it is pure
// data so it ports to the SA image unchanged.

// ---------------------------------------------------------------------------
// Layout
// ---------------------------------------------------------------------------

/** A single CSS-grid layout (matches SA `layout.default`). */
export interface LayoutSpec {
  /** CSS grid-template-columns, e.g. "1fr 1fr 1fr 1fr". */
  columns: string;
  /** CSS grid-template-rows, e.g. "auto auto 1fr". */
  rows: string;
  /**
   * CSS grid-template-areas as ASCII art. One quoted row per line, e.g.
   *   "metrics metrics"
   *   "chart   table"
   * Every token used here MUST be a key in `PageSpec.areas`.
   */
  grid: string;
}

/** Responsive layout set (matches SA: default required, breakpoints optional). */
export interface ResponsiveLayout {
  default: LayoutSpec;
  tablet?: LayoutSpec;
  mobile?: LayoutSpec;
}

// ---------------------------------------------------------------------------
// Data sources
// ---------------------------------------------------------------------------

/**
 * Context values a query/param can re-bind to. The control app switches region
 * server-side (CONFIG table) so most queries do not parametrize region; instead
 * they re-run when one of these changes. `dataset` covers the synthetic-data
 * dataset picker.
 */
export type RefetchTrigger = 'region' | 'vehicle' | 'dataset';

/**
 * A declarative SQL data source (matches SA area `data`).
 *
 * `query` is sent to `/api/query` verbatim except for `:param` placeholders,
 * which are resolved from `params` against the binding scope `{ region, vehicle,
 * viewState }` and inlined as SQL literals (string -> quoted, number -> raw,
 * null/undefined -> NULL). Param values originate from builder-authored specs
 * and DISTINCT-value filter queries, mirroring SA's model.
 */
export interface DataSourceSpec {
  query: string;
  /** Snowflake database; defaults to FLEET_INTELLIGENCE when omitted. */
  database?: string;
  /** Snowflake schema; component/page default applies when omitted. */
  schema?: string;
  /**
   * Map of `:placeholder` -> dot-path into the binding scope, e.g.
   * `{ selected_status: "viewState.selectedStatus", region: "region.regionName" }`.
   */
  params?: Record<string, string>;
  /** Re-run the query when any of these context values change. */
  refetchOn?: RefetchTrigger[];
}

// ---------------------------------------------------------------------------
// Map layer DSL (the asset SA lacks)
// ---------------------------------------------------------------------------

/** RGBA color, each channel 0-255. */
export type ColorRGBA = [number, number, number, number];

/**
 * A conditional color: when `whenViewStateEquals` matches the row's `matchColumn`
 * value, use `active`; otherwise `base`. Models the common "highlight selected"
 * pattern (e.g. FleetMap selected courier).
 */
export interface ConditionalColor {
  base: ColorRGBA;
  active: ColorRGBA;
  /** Row column compared for the highlight. */
  matchColumn: string;
  /** Dot-path into viewState whose value is compared against `matchColumn`. */
  whenViewStateEquals: string;
}

export type ColorValue = ColorRGBA | ConditionalColor;

interface LayerBase {
  /** Optional stable layer id; auto-generated from index when omitted. */
  id?: string;
  /** Each layer owns its data query (matches how pages fetch per-layer data). */
  data: DataSourceSpec;
  /** Make the layer pickable for tooltips. */
  pickable?: boolean;
  /** HTML tooltip template using `{COLUMN}` tokens, e.g. "<b>{COURIER_ID}</b>". */
  tooltip?: string;
}

/** Point layer: maps lng/lat columns to positions. */
export interface ScatterplotLayerSpec extends LayerBase {
  type: 'scatterplot';
  lng: string;
  lat: string;
  fillColor?: ColorValue;
  radius?: number;
  radiusMinPixels?: number;
  radiusMaxPixels?: number;
}

/**
 * Line/route layer. Path comes from a GeoJSON LineString column when present,
 * otherwise from a straight start->end segment built from coordinate columns.
 */
export interface PathLayerSpec extends LayerBase {
  type: 'path';
  /** Column holding a GeoJSON geometry string (ST_ASGEOJSON output). */
  geojsonColumn?: string;
  start?: { lng: string; lat: string };
  end?: { lng: string; lat: string };
  color?: ColorRGBA;
  width?: number;
  widthMinPixels?: number;
}

/** H3 hexagon layer for aggregated density/value maps. */
export interface H3HexagonLayerSpec extends LayerBase {
  type: 'h3';
  hexColumn: string;
  /** Numeric column driving color (and optionally elevation). */
  valueColumn?: string;
  /** Two-stop color scale [low, high]; value is normalized across rows. */
  colorScale?: [ColorRGBA, ColorRGBA];
  extruded?: boolean;
}

/** GeoJSON layer for polygons/boundaries (e.g. isochrones, region boundary). */
export interface GeoJsonLayerSpec extends LayerBase {
  type: 'geojson';
  geojsonColumn: string;
  fillColor?: ColorRGBA;
  lineColor?: ColorRGBA;
  lineWidth?: number;
}

/** Arc layer for origin->destination flows. */
export interface ArcLayerSpec extends LayerBase {
  type: 'arc';
  source: { lng: string; lat: string };
  target: { lng: string; lat: string };
  sourceColor?: ColorRGBA;
  targetColor?: ColorRGBA;
  width?: number;
}

export type LayerSpec =
  | ScatterplotLayerSpec
  | PathLayerSpec
  | H3HexagonLayerSpec
  | GeoJsonLayerSpec
  | ArcLayerSpec;

// ---------------------------------------------------------------------------
// Area (widget) specs
// ---------------------------------------------------------------------------

export type NumberFormat = 'number' | 'decimal' | 'percent' | 'integer' | 'text';

/** One KPI tile sourced from a column of the first result row. */
export interface MetricMapping {
  column: string;
  label: string;
  format?: NumberFormat;
  /** Optional suffix appended to the value, e.g. " min". */
  suffix?: string;
}

export interface MetricCardsArea {
  component: 'MetricCards';
  title?: string;
  data: DataSourceSpec;
  mapping: { metrics: MetricMapping[] };
}

export type ChartType = 'line' | 'bar' | 'stackedBar' | 'area' | 'pie' | 'scatter';

export interface ChartSeries {
  dataKey: string;
  label?: string;
  color?: string;
}

export interface ChartArea {
  component: 'Chart';
  title?: string;
  data: DataSourceSpec;
  config: {
    chartType: ChartType;
    /** Category/x-axis column. For pie, the label column. */
    xKey: string;
    series: ChartSeries[];
    /** Bar orientation; vertical = horizontal bars. */
    orientation?: 'horizontal' | 'vertical';
    height?: number;
    /**
     * Optional per-row key mapping to rename/cast columns before charting,
     * e.g. { day: "DAY", dwells: "TOTAL_DWELLS" }. Values are row column names;
     * the resulting objects use the keys. Numeric coercion is applied.
     */
    map?: Record<string, string>;
  };
}

export interface TableColumn {
  field: string;
  header?: string;
  width?: number;
}

export interface TableArea {
  component: 'Table';
  title?: string;
  data: DataSourceSpec;
  config?: {
    columns?: TableColumn[];
    maxRows?: number;
  };
}

export interface FilterDef {
  name: string;
  label: string;
  /** Options query; rows mapped via `mapping` to {value,label}. */
  data: DataSourceSpec & { mapping: { value: string; label: string } };
  /** viewState key written when the user picks an option. */
  emits: string;
}

export interface FilterBarArea {
  component: 'FilterBar';
  title?: string;
  filters: FilterDef[];
}

export interface ComboBoxArea {
  component: 'ComboBox';
  title?: string;
  filter: FilterDef;
}

export interface MapArea {
  component: 'Map';
  title?: string;
  layers: LayerSpec[];
  /** Remove inner padding so the map fills its grid cell. */
  noPad?: boolean;
  /** Fixed pixel height; defaults to filling the grid row. */
  height?: number;
}

/**
 * Escape hatch for Tier-3 interactive pages: render a full-page component
 * registered by key in the registry, bypassing the area model entirely
 * (mirrors SA's `viewRegistry` full-page views, e.g. WorkflowManager).
 */
export interface CustomArea {
  component: string;
  title?: string;
  /** Free-form props forwarded to the custom component. */
  props?: Record<string, unknown>;
}

export type AreaSpec =
  | MetricCardsArea
  | ChartArea
  | TableArea
  | FilterBarArea
  | ComboBoxArea
  | MapArea
  | CustomArea;

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export interface PageSpec {
  /** Stable id; also used as the nav tab key when wired into App.tsx. */
  id: string;
  label?: string;
  description?: string;
  /** Default Snowflake schema applied to areas that omit one. */
  defaultSchema?: string;
  /** Default Snowflake database applied to areas that omit one. */
  defaultDatabase?: string;
  layout: ResponsiveLayout;
  /** Areas keyed by the tokens used in `layout.*.grid`. */
  areas: Record<string, AreaSpec>;
}

/** A page that renders a single full-bleed custom component (no grid). */
export function isCustomArea(area: AreaSpec): area is CustomArea {
  const known = ['MetricCards', 'Chart', 'Table', 'FilterBar', 'ComboBox', 'Map'];
  return !known.includes(area.component);
}

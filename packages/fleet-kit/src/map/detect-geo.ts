// Geospatial column detection: infer a map layer's geometry binding from a
// result set, so an arbitrary query can be mapped without anyone hand-authoring
// a layer spec.
//
// Every map in this codebase is currently authored by hand (a Map area in
// app-views.json) or fully specified by the agent (render_map). Neither path can
// map a result the author did not anticipate, which is the gap behind "the agent
// cannot chart a verb result": the rows are right there, but nothing will say
// which column is the geometry.
//
// Ported from the pattern in snapps MapChartModel.ts (name sets + value-range
// validation + sampled H3 probing), reshaped to this repo's DSL: it returns a
// partial LayerSpec binding rather than a MapConfig, so the result goes through
// the same validateMapLayers path as any other layer. Detection SUGGESTS, it
// does not bypass validation.
//
// Deliberately name-AND-value based. Name alone is how a numeric column called
// `x` holding prices becomes a longitude; values alone is how any two numbers in
// range (a rating and a percentage) become a coordinate pair. Requiring both is
// what makes a wrong guess unlikely, and a wrong guess is worse than no guess
// here - a map that renders in the wrong hemisphere reads as real data.

import { isValidCell } from 'h3-js';

/** Snowflake column type as reported in result metadata, lowercased. */
export type GeoColumnType = string;

export interface DetectColumn {
  name: string;
  /** Snowflake type name from result metadata, e.g. 'GEOGRAPHY', 'TEXT', 'FIXED'. */
  type: GeoColumnType;
}

export type DetectedLayerType = 'scatterplot' | 'geojson' | 'h3';

export interface GeoDetection {
  /** Layer type to bind; maps onto LayerSpec.type. */
  type: DetectedLayerType;
  /** Column holding GeoJSON (geojson) or H3 cell ids (h3). */
  geojsonColumn?: string;
  hexColumn?: string;
  /** Point columns (scatterplot). */
  lng?: string;
  lat?: string;
  /** Which probe matched, for surfacing "why is this a map" to a user. */
  reason: string;
}

/**
 * Column-name candidates. Matched on an exact lowercased name rather than a
 * substring: `substring` would take `latency` for a latitude and `longitude_bin`
 * for a longitude, and the value check cannot save the first of those because a
 * latency in milliseconds is frequently inside [-90, 90].
 */
const LAT_NAMES = new Set([
  'lat', 'latitude', 'y', 'lat_y', 'point_lat', 'start_lat', 'origin_lat', 'pickup_lat',
]);
const LON_NAMES = new Set([
  'lon', 'lng', 'long', 'longitude', 'x', 'lon_x', 'point_lon', 'point_lng',
  'start_lon', 'start_lng', 'origin_lon', 'origin_lng', 'pickup_lon', 'pickup_lng',
]);

/** Snowflake numeric type names as they appear in result metadata. */
const NUMERIC_TYPES = new Set(['fixed', 'real', 'number', 'float', 'integer', 'decimal', 'double']);
const TEXT_TYPES = new Set(['text', 'string', 'varchar', 'char']);
const GEO_TYPES = new Set(['geography', 'geometry']);

/** Rows sampled for value checks. Enough to catch a wrong column, cheap on a large result. */
const SAMPLE_ROWS = 10;
/** Rows sampled for the H3 probe; cell ids are uniform so fewer are needed. */
const H3_SAMPLE_ROWS = 5;

type Row = Record<string, unknown>;

function typeOf(c: DetectColumn): string {
  return String(c.type ?? '').toLowerCase();
}

function isLatValue(v: unknown): boolean {
  return typeof v === 'number' && Number.isFinite(v) && v >= -90 && v <= 90;
}

function isLonValue(v: unknown): boolean {
  return typeof v === 'number' && Number.isFinite(v) && v >= -180 && v <= 180;
}

/** Non-null values of a column from the first `limit` rows. */
function sampleValues(rows: Row[], name: string, limit: number): unknown[] {
  const out: unknown[] = [];
  for (let i = 0; i < rows.length && i < limit; i++) {
    const v = rows[i]?.[name];
    if (v != null) out.push(v);
  }
  return out;
}

/**
 * True when a value reads as GeoJSON: an object with a `type` and `coordinates`
 * (or a Feature / FeatureCollection wrapper), or a string that parses to one.
 *
 * A GEOGRAPHY column projected with ST_ASGEOJSON arrives as a string, and the
 * driver sometimes hands back an already-parsed object, so both are accepted -
 * the same two shapes the layer compiler's geoFeatures() handles.
 */
function looksLikeGeoJson(v: unknown): boolean {
  let value: unknown = v;
  if (typeof value === 'string') {
    const t = value.trim();
    if (!t.startsWith('{')) return false;
    try {
      value = JSON.parse(t);
    } catch {
      return false;
    }
  }
  if (value == null || typeof value !== 'object') return false;
  const o = value as { type?: unknown; coordinates?: unknown; geometry?: unknown; features?: unknown };
  if (o.type === 'Feature') return o.geometry != null;
  if (o.type === 'FeatureCollection') return Array.isArray(o.features);
  return typeof o.type === 'string' && o.coordinates != null;
}

/**
 * Detects an H3 column by validating sampled values as real cell indices.
 *
 * Not by string length: every valid H3 index is 15 hex characters at every
 * resolution, so a length test admits any 15-character id - an order number, a
 * hash prefix - and would bind it as a hexagon layer that renders nothing.
 * Every sampled value must validate, so one good-looking row cannot carry a
 * column of unrelated ids.
 */
function detectH3Column(columns: DetectColumn[], rows: Row[]): string | undefined {
  for (const col of columns) {
    if (!TEXT_TYPES.has(typeOf(col))) continue;
    const sample = sampleValues(rows, col.name, H3_SAMPLE_ROWS);
    if (sample.length === 0) continue;
    if (sample.every((v) => typeof v === 'string' && isValidCell(v))) return col.name;
  }
  return undefined;
}

/** Detects a GeoJSON-bearing column: declared GEOGRAPHY/GEOMETRY first, then by value. */
function detectGeoJsonColumn(columns: DetectColumn[], rows: Row[]): { name: string; declared: boolean } | undefined {
  // Metadata first: a column the warehouse calls GEOGRAPHY is authoritative and
  // needs no value probing, which also covers an empty result set.
  for (const col of columns) {
    if (GEO_TYPES.has(typeOf(col))) return { name: col.name, declared: true };
  }
  // A GEOGRAPHY projected through ST_ASGEOJSON reports as TEXT/VARIANT, so it is
  // only recognisable by shape.
  for (const col of columns) {
    const t = typeOf(col);
    if (!TEXT_TYPES.has(t) && t !== 'variant' && t !== 'object') continue;
    const sample = sampleValues(rows, col.name, H3_SAMPLE_ROWS);
    if (sample.length === 0) continue;
    if (sample.every(looksLikeGeoJson)) return { name: col.name, declared: false };
  }
  return undefined;
}

/**
 * Detects a lat/lon pair. Both the name and the values must agree, and the
 * columns must be distinct - a single column matching both name sets (`y` is in
 * neither, but a schema using `x` for both would) must not pair with itself.
 */
function detectLatLon(columns: DetectColumn[], rows: Row[]): { lat: string; lon: string } | undefined {
  const numeric = columns.filter((c) => NUMERIC_TYPES.has(typeOf(c)));
  let lat: string | undefined;
  let lon: string | undefined;
  for (const col of numeric) {
    const lower = col.name.toLowerCase();
    if (!lat && LAT_NAMES.has(lower)) lat = col.name;
    if (!lon && LON_NAMES.has(lower)) lon = col.name;
  }
  if (!lat || !lon || lat === lon) return undefined;

  const latValues = sampleValues(rows, lat, SAMPLE_ROWS);
  const lonValues = sampleValues(rows, lon, SAMPLE_ROWS);
  // An all-null pair cannot be confirmed. Returning it would bind a layer that
  // draws nothing, which is the blank-map failure this repo already fights.
  if (latValues.length === 0 || lonValues.length === 0) return undefined;
  if (!latValues.every(isLatValue) || !lonValues.every(isLonValue)) return undefined;
  return { lat, lon };
}

/**
 * Infers a geometry binding from result metadata plus a sample of rows, or
 * undefined when nothing in the result is usable as geometry.
 *
 * Probe order is GEOGRAPHY/GEOMETRY metadata, then H3, then GeoJSON by value,
 * then lat/lon. Declared metadata outranks every value heuristic. H3 precedes
 * GeoJSON-by-value because the two probes read the same TEXT columns and an H3
 * id can never parse as GeoJSON, so ordering them this way costs nothing and
 * keeps the cheaper check first.
 */
export function detectGeoColumns(
  columns: DetectColumn[] | null | undefined,
  rows: Row[] | null | undefined,
): GeoDetection | undefined {
  if (!columns?.length) return undefined;
  const sample = rows ?? [];

  const declared = detectGeoJsonColumn(columns, sample);
  if (declared?.declared) {
    return { type: 'geojson', geojsonColumn: declared.name, reason: `column ${declared.name} is GEOGRAPHY/GEOMETRY` };
  }

  const hex = detectH3Column(columns, sample);
  if (hex) return { type: 'h3', hexColumn: hex, reason: `column ${hex} holds valid H3 cell ids` };

  if (declared) {
    return { type: 'geojson', geojsonColumn: declared.name, reason: `column ${declared.name} holds GeoJSON values` };
  }

  const pair = detectLatLon(columns, sample);
  if (pair) {
    return {
      type: 'scatterplot',
      lng: pair.lon,
      lat: pair.lat,
      reason: `columns ${pair.lon}/${pair.lat} are in-range coordinates`,
    };
  }

  return undefined;
}

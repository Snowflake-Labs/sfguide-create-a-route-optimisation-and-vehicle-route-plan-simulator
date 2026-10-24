import type { ProcContext } from '@snowflake/synapse';

type Conn = ProcContext['conn'];
type Obj = Record<string, unknown>;

/**
 * A row set CoWork's data_to_map can draw, returned BESIDE `result`.
 *
 * WHY THIS EXISTS
 * ---------------
 * data_to_map maps the prior tool call only when its structured content is ONE
 * JSON document with a top-level array of objects. Every routing verb returns
 * `{ result: <object> }`, with its geometry on fields inside that object, so
 * CoWork had nothing to map and the agent was told to deep_link instead. The SA
 * app draws `result` itself (multi-layer, full resolution), so `result` is never
 * touched here: `rows` is an additional, simplified, size-bounded projection of
 * the ONE primary geometry the user asked to see.
 *
 * TWO SHAPES, NEVER MIXED
 *   lines/polygons -> [{ GEOJSON: <LineString|Polygon|MultiPolygon|...> }]
 *                     data_to_map layer_type "geojson", geo_column "GEOJSON"
 *   points         -> [{ LON, LAT }]
 *                     data_to_map layer_type "latlon"
 * One call draws one layer, so a verb that has both (catchment polygon + POIs)
 * emits only the polygon.
 *
 * SIZE
 * An MCP result has no query id: the map is an inline snapshot. A cell over
 * 64 KB is dropped (the map then fails with unmappable_rows) and the inlined
 * rows together must stay under ~200 KB. Every geometry is ST_SIMPLIFY'd at
 * 250 m, retried coarser when a cell is still over CELL_MAX, and dropped if
 * even 5 km does not fit. The simplification uses built-in functions only, so
 * it needs no grant and no deployed helper object.
 *
 * BEST EFFORT
 * A failure here never fails the verb: the routing answer stands and the
 * response simply carries no `rows`.
 */

const CELL_MAX = 60_000;
const ROWS_MAX = 190_000;
const POINT_CAP = 2_000;
const DRAWABLE = new Set(['LineString', 'MultiLineString', 'Polygon', 'MultiPolygon']);

export type MapSpec =
  | { kind: 'geojson'; pick: (r: Obj) => unknown[] }
  | { kind: 'points'; pick: (r: Obj) => { lon: unknown; lat: unknown }[] };

/** Google encoded polyline (precision 5), the VROOM/ORS route geometry format. */
function decodePolyline(s: string): number[][] | null {
  const pts: number[][] = [];
  let i = 0;
  let lat = 0;
  let lon = 0;
  while (i < s.length) {
    const deltas: number[] = [];
    for (let k = 0; k < 2; k++) {
      let shift = 0;
      let acc = 0;
      let b: number;
      do {
        if (i >= s.length) return null;
        b = s.charCodeAt(i++) - 63;
        if (b < 0 || b > 63) return null;
        acc |= (b & 0x1f) << shift;
        shift += 5;
      } while (b >= 0x20);
      deltas.push(acc & 1 ? ~(acc >> 1) : acc >> 1);
    }
    lat += deltas[0] as number;
    lon += deltas[1] as number;
    pts.push([lon / 1e5, lat / 1e5]);
  }
  return pts.length >= 2 ? pts : null;
}

function isCoordList(v: unknown): v is number[][] {
  return (
    Array.isArray(v) &&
    v.length >= 2 &&
    v.every((p) => Array.isArray(p) && p.length >= 2 && typeof p[0] === 'number' && typeof p[1] === 'number')
  );
}

/** Flatten any GeoJSON-ish value into drawable geometry objects. Points are dropped. */
export function collectGeometries(v: unknown, out: Obj[] = []): Obj[] {
  if (v === null || v === undefined) return out;
  if (typeof v === 'string') {
    const t = v.trim();
    if (!t) return out;
    if (t[0] === '{' || t[0] === '[') {
      try {
        return collectGeometries(JSON.parse(t), out);
      } catch {
        return out;
      }
    }
    const line = decodePolyline(t);
    if (line) out.push({ type: 'LineString', coordinates: line });
    return out;
  }
  if (isCoordList(v)) {
    out.push({ type: 'LineString', coordinates: v });
    return out;
  }
  if (Array.isArray(v)) {
    for (const x of v) collectGeometries(x, out);
    return out;
  }
  if (typeof v !== 'object') return out;
  const o = v as Obj;
  switch (o.type) {
    case 'FeatureCollection':
      return collectGeometries(o.features, out);
    case 'Feature':
      return collectGeometries(o.geometry, out);
    case 'GeometryCollection':
      return collectGeometries(o.geometries, out);
    default:
      if (typeof o.type === 'string' && DRAWABLE.has(o.type) && Array.isArray(o.coordinates)) out.push(o);
      return out;
  }
}

function num(v: unknown): number | null {
  const n = typeof v === 'string' ? Number(v) : v;
  return typeof n === 'number' && Number.isFinite(n) ? n : null;
}

/** Point rows, nulls dropped, capped by count and by inlined bytes. */
export function pointRows(pts: { lon: unknown; lat: unknown }[]): Obj[] {
  const rows: Obj[] = [];
  let bytes = 2;
  for (const p of pts) {
    if (rows.length >= POINT_CAP) break;
    const lon = num(p.lon);
    const lat = num(p.lat);
    if (lon === null || lat === null) continue;
    const row = { LON: lon, LAT: lat };
    bytes += JSON.stringify(row).length + 1;
    if (bytes > ROWS_MAX) break;
    rows.push(row);
  }
  return rows;
}

// One statement for the whole batch. Each tolerance is tried in order and the
// first output under CELL_MAX wins; NULL (dropped) when even 5 km is too big or
// the input is not a valid geography. ARRAY_AGG skips the NULLs.
const SIMPLIFY_SQL = `
SELECT ARRAY_AGG(GJ) WITHIN GROUP (ORDER BY I) FROM (
  SELECT I,
    CASE
      WHEN LENGTH(ST_ASGEOJSON(ST_SIMPLIFY(G, 250))::STRING)  <= ${CELL_MAX} THEN ST_ASGEOJSON(ST_SIMPLIFY(G, 250))
      WHEN LENGTH(ST_ASGEOJSON(ST_SIMPLIFY(G, 1000))::STRING) <= ${CELL_MAX} THEN ST_ASGEOJSON(ST_SIMPLIFY(G, 1000))
      WHEN LENGTH(ST_ASGEOJSON(ST_SIMPLIFY(G, 5000))::STRING) <= ${CELL_MAX} THEN ST_ASGEOJSON(ST_SIMPLIFY(G, 5000))
    END AS GJ
  FROM (
    SELECT f.INDEX AS I, TRY_TO_GEOGRAPHY(f.VALUE::STRING, TRUE) AS G
    FROM TABLE(FLATTEN(INPUT => PARSE_JSON(?))) f
  )
  WHERE G IS NOT NULL
)`;

async function simplifiedRows(conn: Conn, geoms: Obj[]): Promise<Obj[]> {
  if (geoms.length === 0) return [];
  let raw = await conn.execScalar<unknown>(SIMPLIFY_SQL, [JSON.stringify(geoms)]);
  if (typeof raw === 'string') raw = JSON.parse(raw);
  if (!Array.isArray(raw)) return [];
  const rows: Obj[] = [];
  let bytes = 2;
  for (const g of raw) {
    const geo = typeof g === 'string' ? JSON.parse(g) : g;
    // ST_SIMPLIFY can collapse a short line to a point; that is not drawable here.
    if (!geo || typeof geo !== 'object' || !DRAWABLE.has(String((geo as Obj).type))) continue;
    const row = { GEOJSON: geo };
    const len = JSON.stringify(row).length;
    if (len > CELL_MAX) continue;
    if (bytes + len + 1 > ROWS_MAX) break;
    bytes += len + 1;
    rows.push(row);
  }
  return rows;
}

// `rows` is declared nullable on each verb but is OMITTED, not null, when there
// is nothing to draw (vendored synapse patch 10 keeps an absent key absent).
type MapReturn = { result: Obj; rows: Obj[] | null };

/**
 * Return `{ result }`, plus top-level `rows` when the call SUCCEEDED and there
 * is something to draw. `result` is returned exactly as the tool produced it.
 */
export async function withMapRows(conn: Conn, result: Obj, spec: MapSpec): Promise<MapReturn> {
  const bare = { result } as MapReturn;
  if (String(result.status ?? '') !== 'SUCCESS') return bare;
  try {
    const rows =
      spec.kind === 'points'
        ? pointRows(spec.pick(result))
        : await simplifiedRows(conn, collectGeometries(spec.pick(result)));
    return rows.length > 0 ? { result, rows } : bare;
  } catch {
    return bare;
  }
}

// --- per-verb picks -----------------------------------------------------------

/** The primary geometry lives on one named field of the result. */
export function geometryAt(field: string): MapSpec {
  return { kind: 'geojson', pick: (r) => [r[field]] };
}

/** One line per optimized route; a route without geometry contributes nothing. */
export const routeGeometries: MapSpec = {
  kind: 'geojson',
  pick: (r) => (Array.isArray(r.routes) ? (r.routes as Obj[]).map((x) => x?.geometry) : []),
};

/** Snap hits only: an unsnapped point has a null snapped_lon/lat and is skipped. */
export const snappedPoints: MapSpec = {
  kind: 'points',
  pick: (r) =>
    (Array.isArray(r.points) ? (r.points as Obj[]) : []).map((p) => ({ lon: p?.snapped_lon, lat: p?.snapped_lat })),
};

/** Point features of a FeatureCollection on `geometry` (Overture list mode). */
export const featurePoints: MapSpec = {
  kind: 'points',
  pick: (r) => {
    const fc = r.geometry as Obj | null | undefined;
    const feats = fc && Array.isArray(fc.features) ? (fc.features as Obj[]) : [];
    return feats.map((f) => {
      const c = (f?.geometry as Obj | undefined)?.coordinates;
      return Array.isArray(c) ? { lon: c[0], lat: c[1] } : { lon: null, lat: null };
    });
  },
};

/** Shared `returns.rows` description, so every verb documents the same contract. */
export const ROWS_DESCRIPTION =
  'Present only on SUCCESS when there is something to draw. A map-ready row set for CoWork data_to_map: ' +
  'rows of { GEOJSON } (layer_type "geojson", geo_column "GEOJSON") or rows of { LON, LAT } ' +
  '(layer_type "latlon"), never both. Simplified and size-capped; `result` holds the full geometry.';

import type { ProcContext } from '@snowflake/synapse';

type Conn = ProcContext['conn'];
type Identity = ProcContext['identity'];
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
 * rows together must stay under ~200 KB. DETAIL FIRST, COARSEN ONLY TO FIT:
 * one tolerance is chosen for the whole call - the finest of full resolution,
 * 5 / 25 / 100 / 250 / 1000 / 5000 m at which every geometry that can fit a
 * cell does, and the row set stays under ROWS_MAX. A geometry over CELL_MAX
 * even at 5 km is dropped. Measured: Civic Center -> Golden Gate is 151 points
 * / 3.6 KB at full resolution and was 7 straight segments under the old fixed
 * 250 m first tier. One shared tolerance (rather than a per-row share of
 * ROWS_MAX) means a multi-route result is coarsened together and keeps every
 * route; an equal per-row share dropped ALL rows of a set whose rows each
 * slightly exceeded it. The simplification uses built-in functions only, so it
 * needs no grant and no deployed helper object.
 *
 * BEST EFFORT
 * A failure here never fails the verb: the routing answer stands and the
 * response simply carries no `rows`.
 *
 * WHY rows ALONE DOES NOT DRAW IN COWORK, AND result_id
 * The managed MCP server delivers a verb's output to the agent as
 * {"json":{"result":"<this whole document as a STRING>"}}, so `rows` is never
 * at the top level and data_to_map cannot read it (observed failing in CoWork
 * on 2026-10-24: get_directions ok, no map). The same rows are therefore
 * persisted to FLEET_INTELLIGENCE.ROUTING_TOOLS.ROUTING_RESULT_GEOMETRY under a
 * fresh `result_id`; SV_ROUTING_RESULTS (Analyst tool query_routing_results)
 * serves them back, and a Cortex Analyst result IS a source data_to_map draws.
 * `rows` stays in the response for the SA app and any client that reads
 * structured content directly.
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

// One statement for the whole batch. Every geometry is rendered at each tier of
// the ladder (0 = unsimplified). PICK is the finest tier at which the MOST
// geometries fit a cell AND the row set fits ROWS_MAX; when no tier does, the
// coarsest tier that still fits the most (the TS loop below then truncates as a
// backstop). "The most" is the maximum over ALL tiers, not the 5 km count:
// ST_SIMPLIFY collapses a short line to NULL at 5 km, so measured against the
// 5 km tier a 3.5 km city route matched nothing and drew no map at all.
// A geometry that does not fit a cell at the picked tier, or is not a valid
// geography, is dropped.
const TOLERANCES_M = [0, 5, 25, 100, 250, 1000, 5000];
// Bytes the { GEOJSON: ... } wrapper and the array separator add to each cell.
const ROW_OVERHEAD = 16;
const SIMPLIFY_SQL = `
WITH LAD AS (
  SELECT g.I, t.VALUE::NUMBER AS TOL,
         ST_ASGEOJSON(IFF(t.VALUE = 0, g.G, ST_SIMPLIFY(g.G, t.VALUE::NUMBER)))::STRING AS GJ
  FROM (
    SELECT f.INDEX AS I, TRY_TO_GEOGRAPHY(f.VALUE::STRING, TRUE) AS G
    FROM TABLE(FLATTEN(INPUT => PARSE_JSON(?))) f
  ) g,
  TABLE(FLATTEN(INPUT => ARRAY_CONSTRUCT(${TOLERANCES_M.join(', ')}))) t
  WHERE g.G IS NOT NULL
),
TIERS AS (
  SELECT TOL,
         COUNT_IF(LENGTH(GJ) <= ${CELL_MAX}) AS FIT,
         SUM(IFF(LENGTH(GJ) <= ${CELL_MAX}, LENGTH(GJ) + ${ROW_OVERHEAD}, 0)) AS BYTES
  FROM LAD GROUP BY TOL
),
BEST AS (SELECT MAX(FIT) AS F FROM TIERS),
PICK AS (
  SELECT COALESCE(MIN(IFF(BYTES <= ${ROWS_MAX} AND FIT = BEST.F, TOL, NULL)),
                  MAX(IFF(FIT = BEST.F, TOL, NULL))) AS T
  FROM TIERS, BEST
)
SELECT ARRAY_AGG(GJ) WITHIN GROUP (ORDER BY I)
FROM LAD, PICK
WHERE LAD.TOL = PICK.T AND LENGTH(GJ) <= ${CELL_MAX}`;

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
    // Backstop only: the picked tolerance already keeps the sum under ROWS_MAX.
    if (bytes + len + 1 > ROWS_MAX) break;
    bytes += len + 1;
    rows.push(row);
  }
  return rows;
}

const GEOMETRY_TABLE = 'FLEET_INTELLIGENCE.ROUTING_TOOLS.ROUTING_RESULT_GEOMETRY';

// One statement for the whole row set: geojson rows fill GEOJSON, point rows
// fill LON/LAT, H3 rows fill H3. VALUE/LABEL are only set by run_sql rows.
// TO_JSON keeps the geometry a compact GeoJSON string.
const PERSIST_SQL = `
INSERT INTO ${GEOMETRY_TABLE} (RESULT_ID, VERB, ACTOR, SEQ, GEOJSON, LON, LAT, H3, VALUE, LABEL)
SELECT ?, ?, ?, f.INDEX,
       IFF(f.VALUE:GEOJSON IS NULL, NULL, TO_JSON(f.VALUE:GEOJSON)),
       f.VALUE:LON::FLOAT, f.VALUE:LAT::FLOAT,
       f.VALUE:H3::STRING, f.VALUE:VALUE::FLOAT, f.VALUE:LABEL::STRING
FROM TABLE(FLATTEN(INPUT => PARSE_JSON(?))) f`;

const PURGE_SQL = `DELETE FROM ${GEOMETRY_TABLE} WHERE CREATED_AT < DATEADD(day, -7, CURRENT_TIMESTAMP())`;

/**
 * Persist `rows` and return the id they are stored under, or null when the
 * write failed (the verb still answers; the agent then has no map source).
 */
async function persistRows(conn: Conn, identity: Identity, verb: string, rows: Obj[]): Promise<string | null> {
  try {
    const id = await conn.execScalar<string>('SELECT UUID_STRING()');
    if (!id) return null;
    await conn.exec(PERSIST_SQL, [id, verb, identity.user, JSON.stringify(rows)]);
    try {
      await conn.exec(PURGE_SQL);
    } catch {
      // Retention is housekeeping; it never costs the caller the id.
    }
    return id;
  } catch {
    return null;
  }
}

// `rows` and `result_id` are declared nullable on each verb but are OMITTED,
// not null, when absent (vendored synapse patch 10 keeps an absent key absent).
type MapReturn = { result: Obj; rows: Obj[] | null; result_id: string | null };

/**
 * Return `{ result }`, plus top-level `rows` and `result_id` when the call
 * SUCCEEDED and there is something to draw. `result` is returned exactly as
 * the tool produced it.
 */
export async function withMapRows(
  ctx: Pick<ProcContext, 'conn' | 'identity'>,
  verb: string,
  result: Obj,
  spec: MapSpec,
): Promise<MapReturn> {
  const bare = { result } as MapReturn;
  if (String(result.status ?? '') !== 'SUCCESS') return bare;
  try {
    const rows =
      spec.kind === 'points'
        ? pointRows(spec.pick(result))
        : await simplifiedRows(ctx.conn, collectGeometries(spec.pick(result)));
    if (rows.length === 0) return bare;
    const id = await persistRows(ctx.conn, ctx.identity, verb, rows);
    return id ? { result, rows, result_id: id } : ({ result, rows } as MapReturn);
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

// --- run_sql ----------------------------------------------------------------
//
// run_sql has no fixed geometry field: its rows are whatever the query selected.
// The drawable shape is read off the COLUMN NAMES of the first row, one shape per
// result (never mixed, same rule as the verbs):
//   H3 cell string column (name has H3/CELL/HEX) -> { H3 }     layer_type h3
//   LAT + LON/LNG/LONGITUDE                     -> { LON, LAT }  layer_type latlon
//   GEOJSON / GEOM / GEOMETRY / GEOG           -> { GEOJSON }   layer_type geojson
// plus the first other numeric column as VALUE (colour/height) and the first
// other string column as LABEL. H3 must be the hex STRING form: a 64-bit H3 INT
// does not survive the JS number round trip, so an integer H3 column is not drawn.
// Geometry is NOT simplified (the caller chose it); a cell over CELL_MAX is dropped.

const H3_HEX = /^[0-9a-f]{15,16}$/i;
const LAT_KEYS = ['LAT', 'LATITUDE'];
const LON_KEYS = ['LON', 'LNG', 'LONGITUDE'];
const GEO_KEYS = ['GEOJSON', 'GEOM', 'GEOMETRY', 'GEOG', 'GEOGRAPHY'];

function findKey(keys: string[], names: string[]): string | undefined {
  return keys.find((k) => names.includes(k.toUpperCase()));
}

function asGeometry(v: unknown): Obj | null {
  const g = collectGeometries(v);
  if (g.length === 0) return null;
  return g.length === 1 ? (g[0] as Obj) : { type: 'GeometryCollection', geometries: g };
}

/** Project run_sql result rows to map rows, or [] when nothing is drawable. */
export function sqlMapRows(rows: Obj[]): Obj[] {
  const first = rows[0];
  if (!first || typeof first !== 'object') return [];
  const keys = Object.keys(first);
  const h3Key = keys.find((k) => /H3|CELL|HEX/.test(k.toUpperCase()) && typeof first[k] === 'string' && H3_HEX.test(String(first[k])));
  const latKey = findKey(keys, LAT_KEYS);
  const lonKey = findKey(keys, LON_KEYS);
  const geoKey = findKey(keys, GEO_KEYS);
  const shape = h3Key ? 'h3' : latKey && lonKey ? 'latlon' : geoKey ? 'geojson' : null;
  if (!shape) return [];
  const used = new Set([h3Key, latKey, lonKey, geoKey].filter(Boolean) as string[]);
  const valueKey = keys.find((k) => !used.has(k) && num(first[k]) !== null && typeof first[k] !== 'boolean');
  const labelKey = keys.find((k) => !used.has(k) && k !== valueKey && typeof first[k] === 'string');

  const out: Obj[] = [];
  let bytes = 2;
  for (const r of rows) {
    if (out.length >= POINT_CAP) break;
    let row: Obj | null = null;
    if (shape === 'h3') {
      const h = r[h3Key as string];
      if (typeof h === 'string' && H3_HEX.test(h)) row = { H3: h.toLowerCase() };
    } else if (shape === 'latlon') {
      const lon = num(r[lonKey as string]);
      const lat = num(r[latKey as string]);
      if (lon !== null && lat !== null) row = { LON: lon, LAT: lat };
    } else {
      const g = asGeometry(r[geoKey as string]);
      if (g) row = { GEOJSON: g };
    }
    if (!row) continue;
    if (valueKey) row.VALUE = num(r[valueKey]);
    if (labelKey && r[labelKey] != null) row.LABEL = String(r[labelKey]).slice(0, 200);
    const len = JSON.stringify(row).length;
    if (len > CELL_MAX) continue;
    if (bytes + len + 1 > ROWS_MAX) break;
    bytes += len + 1;
    out.push(row);
  }
  return out;
}

/**
 * Persist run_sql's drawable rows and return their result_id, or null when the
 * result has nothing to draw or the write failed. Never throws.
 */
export async function persistSqlMapRows(
  ctx: Pick<ProcContext, 'conn' | 'identity'>,
  rows: Obj[],
): Promise<string | null> {
  try {
    const mapRows = sqlMapRows(rows);
    if (mapRows.length === 0) return null;
    return await persistRows(ctx.conn, ctx.identity, 'run_sql', mapRows);
  } catch {
    return null;
  }
}

/** Shared `returns.rows` description, so every verb documents the same contract. */
export const ROWS_DESCRIPTION =
  'Present only on SUCCESS when there is something to draw. A map-ready row set for CoWork data_to_map: ' +
  'rows of { GEOJSON } (layer_type "geojson", geo_column "GEOJSON") or rows of { LON, LAT } ' +
  '(layer_type "latlon"), never both. Full detail where it fits, simplified only to stay within the map ' +
  'size caps; `result` holds the full geometry.';

/** Shared `returns.result_id` description. */
export const RESULT_ID_DESCRIPTION =
  'Present only when rows is present. The id the map rows are stored under. In CoWork, data_to_map ' +
  'cannot read this verb result directly: call query_routing_results asking for the geometry of this ' +
  'result_id, then pass THAT call\'s tool_use_id to data_to_map.';

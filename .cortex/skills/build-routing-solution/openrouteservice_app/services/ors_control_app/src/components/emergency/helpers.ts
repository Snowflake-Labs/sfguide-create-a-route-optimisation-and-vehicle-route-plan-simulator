// Shared helpers for the single-page Emergency Response evacuation wizard.
//
// The wizard is fully client-driven: every step issues a read-only SELECT via
// /api/query (risk ZIPs, isochrone-bounded Overture sampling, VROOM solve),
// mirroring RouteOptimization / AssetVelocity / BackloadMatching. No server
// state is persisted -- seeded participants live in React state between steps
// and are embedded into the VROOM challenge at plan time.

export type Hazard = 'flood' | 'wildfire';

export type StateOption = {
  stateCode: string;     // 'CO'
  stateName: string;     // 'Colorado'
  orsRegion: string;     // 'UsColorado' (key ISOCHRONES/OPTIMIZATION accept)
  enabled: boolean;
};

export type RiskZip = {
  zip: string;
  level: number;         // 0..5
  label: string;         // 'Very High' etc.
  geojson: any;          // GeoJSON Polygon/MultiPolygon
};

export type Center = {
  centerId: string;
  name: string;
  lon: number;
  lat: number;
};

export type Participant = {
  id: string;
  lon: number;
  lat: number;
  zip: string;
  riskLevel: number;     // 0..5 for the active hazard
  riskLabel: string;
  centerId: string;      // nearest center (computed client-side)
};

// Per-center vehicle configuration (Step 3).
export type VehicleConfig = {
  centerId: string;
  numVehicles: number;
  capacity: number;
};

// One pickup stop on a trip.
export type PlanStop = {
  seq: number;            // 1-based order within the trip
  lon: number;
  lat: number;
  participantId: string;
};

// One trip = one round trip from a center (a physical vehicle may make several).
export type PlanTrip = {
  tripKey: string;        // stable unique key: `${physIndex}:${tripNumber}`
  physIndex: number;      // physical vehicle index (for coloring)
  vehicleLabel: string;   // e.g. "Denver Veh 1"
  centerId: string;
  tripNumber: number;     // 1-based trip ordinal for this physical vehicle
  geojson: any;           // route LineString / Feature
  stops: PlanStop[];
  load: number;           // = stops.length
  capacity: number;
  durationSec: number;
};

// ---------------------------------------------------------------------------
// Risk palette -- ordinal 0..5 (No rating .. Very High). RGBA for deck.gl.
// ---------------------------------------------------------------------------
export const RISK_RGBA: Record<number, [number, number, number, number]> = {
  0: [200, 200, 200, 60],   // No rating / insufficient
  1: [38, 166, 91, 120],    // Very Low      -> green
  2: [163, 209, 90, 130],   // Relatively Low
  3: [247, 202, 24, 150],   // Relatively Moderate -> yellow
  4: [230, 126, 34, 170],   // Relatively High     -> orange
  5: [192, 57, 43, 200],    // Very High           -> red
};

export const RISK_HEX: Record<number, string> = {
  0: '#c8c8c8', 1: '#26a65b', 2: '#a3d15a', 3: '#f7ca18', 4: '#e67e22', 5: '#c0392b',
};

export const RISK_NAME: Record<number, string> = {
  0: 'No Rating', 1: 'Very Low', 2: 'Relatively Low',
  3: 'Relatively Moderate', 4: 'Relatively High', 5: 'Very High',
};

export const ER_DB = 'EMERGENCY_RESPONSE';
export const ER_SCHEMA = 'PIPELINE';

// ---------------------------------------------------------------------------
// sfQuery -- read-only SQL proxy. Throws on error so the wizard can surface it.
// ---------------------------------------------------------------------------
export async function sfQuery(
  sql: string,
  database = ER_DB,
  schema = ER_SCHEMA,
  opts: { throwOnError?: boolean } = {},
): Promise<any[]> {
  const res = await fetch('/api/query', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sql, database, schema }),
  });
  const body = await res.json().catch(() => ({}));
  if (body && body.error) {
    if (opts.throwOnError) throw new Error(String(body.error));
    return [];
  }
  const rows = Array.isArray(body) ? body : (body.result ?? []);
  return Array.isArray(rows) ? rows : [];
}

const sqlStr = (v: string) => `'${String(v).replace(/'/g, "''")}'`;

// ---------------------------------------------------------------------------
// SQL builders
// ---------------------------------------------------------------------------
export function statesSql(): string {
  return `SELECT STATE_CODE, STATE_NAME, ORS_REGION, ENABLED
          FROM EMERGENCY_RESPONSE.CONFIG.STATE_REGION_MAP
          ORDER BY STATE_NAME`;
}

/** ORS readiness probe for the chosen region key. */
export function orsStatusSql(orsRegion: string): string {
  return `SELECT TO_VARCHAR(OPENROUTESERVICE_APP.CORE.ORS_STATUS(${sqlStr(orsRegion)})) AS S`;
}

/** Risk-colored ZIP polygons for a state + hazard. */
export function riskZipsSql(stateCode: string, hazard: Hazard): string {
  const lvl = hazard === 'wildfire' ? 'WILDFIRE_LEVEL' : 'FLOOD_LEVEL';
  const lbl = hazard === 'wildfire' ? 'WILDFIRE_LABEL' : 'FLOOD_LABEL';
  return `SELECT ZIP_CODE AS ZIP, ${lvl} AS LEVEL, ${lbl} AS LABEL,
                 ST_ASGEOJSON(ZIP_GEOMETRY) AS GEOJSON
          FROM EMERGENCY_RESPONSE.PIPELINE.V_ZIP_RISK
          WHERE STATE = ${sqlStr(stateCode)}`;
}

/** InnovAge centers in a state. */
export function centersSql(stateCode: string): string {
  return `SELECT CENTER_ID, CENTER_NAME, LON, LAT
          FROM EMERGENCY_RESPONSE.CORE.INNOVAGE_CENTERS
          WHERE STATE = ${sqlStr(stateCode)}
          ORDER BY CENTER_NAME`;
}

/**
 * Seed query: in ONE statement (so ORS isochrones run once), return both the
 * drive-time isochrone union (for the Step 2 sanity overlay) and a spatially
 * even sample of `numPatients` participant points inside that union, tagged
 * with their ZIP's risk for the active hazard.
 *
 * Sampling is AREA-UNIFORM via rejection sampling, NOT drawn from address rows.
 * An earlier address-row approach (even H3-stratified) could only place points
 * where Overture `ADDRESS` data exists, and that coverage is itself spatially
 * banded -- e.g. the PA 15-min union's SE quadrant has zero Overture addresses,
 * so the map stayed clustered in a western band no matter how we sampled. To
 * cover the whole polygon we instead scatter uniform random points across the
 * union's bounding box and keep those inside the union (`ST_WITHIN`). Snowflake
 * has no PostGIS `ST_GeneratePoints`, so this GENERATOR + UNIFORM rejection loop
 * is the equivalent. Spread is area-proportional: larger isochrone lobes get
 * proportionally more points (dense metros still get more total), but every
 * part of the polygon -- including address-free areas -- is now covered.
 *
 * Each surviving point is a synthetic participant location (appropriate for an
 * evacuation demo). ZIP + hazard risk are still real: tagged by point-in-polygon
 * against V_ZIP_RISK. ZIP polygons are SRID=0 planar GEOMETRY, so we ST_SETSRID
 * them to 4326 and TO_GEOGRAPHY before the spatial join to match the GEOGRAPHY
 * points/union.
 *
 * `cands` over-samples the bounding box (clamped n*50, 6000..60000) so enough
 * candidates land inside the union to satisfy `LIMIT n` after rejection.
 *
 * Returns a single row: { UNION_GEOJSON (string), PARTICIPANTS (array) }.
 * driveMinutes is passed straight to ORS (minutes semantics).
 */
export function seedSql(stateCode: string, orsRegion: string, hazard: Hazard, numPatients: number, driveMinutes: number): string {
  const lvl = hazard === 'wildfire' ? 'WILDFIRE_LEVEL' : 'FLOOD_LEVEL';
  const lbl = hazard === 'wildfire' ? 'WILDFIRE_LABEL' : 'FLOOD_LABEL';
  const n = Math.max(1, Math.min(1000, Math.floor(numPatients)));
  const mins = Math.max(1, Math.min(180, Math.floor(driveMinutes)));
  const cands = Math.max(6000, Math.min(60000, n * 50));
  return `WITH per_center AS (
            SELECT CENTER_ID,
                   EMERGENCY_RESPONSE.CORE.ORS_ISOCHRONE_FOR_CENTER(LOC, ${mins}, ${sqlStr(orsRegion)}) AS iso
            FROM EMERGENCY_RESPONSE.CORE.INNOVAGE_CENTERS
            WHERE STATE = ${sqlStr(stateCode)}
          ),
          u AS (SELECT ST_UNION_AGG(iso) AS area FROM per_center WHERE iso IS NOT NULL),
          b AS (
            SELECT area, ST_XMIN(area) AS xmin, ST_XMAX(area) AS xmax,
                   ST_YMIN(area) AS ymin, ST_YMAX(area) AS ymax
            FROM u
          ),
          zips AS (
            SELECT ZIP_CODE, ${lvl} AS LVL, ${lbl} AS LBL,
                   TO_GEOGRAPHY(ST_SETSRID(ZIP_GEOMETRY, 4326)) AS g
            FROM EMERGENCY_RESPONSE.PIPELINE.V_ZIP_RISK
            WHERE STATE = ${sqlStr(stateCode)}
          ),
          cand AS (
            SELECT b.area,
                   b.xmin + (b.xmax - b.xmin) * UNIFORM(0::FLOAT, 1::FLOAT, RANDOM()) AS LON,
                   b.ymin + (b.ymax - b.ymin) * UNIFORM(0::FLOAT, 1::FLOAT, RANDOM()) AS LAT
            FROM b, TABLE(GENERATOR(ROWCOUNT => ${cands}))
          ),
          inside AS (
            SELECT LON, LAT, ST_POINT(LON, LAT) AS PT
            FROM cand
            WHERE ST_WITHIN(ST_POINT(LON, LAT), area)
          ),
          samp AS (
            SELECT LON, LAT, PT, 'P' || ROW_NUMBER() OVER (ORDER BY RANDOM()) AS PID
            FROM inside
            ORDER BY RANDOM()
            LIMIT ${n}
          ),
          samp_risk AS (
            SELECT s.PID, s.LON, s.LAT, z.ZIP_CODE AS ZIP,
                   COALESCE(z.LVL, 0) AS RISK_LEVEL,
                   COALESCE(z.LBL, 'No Rating') AS RISK_LABEL
            FROM samp s
            LEFT JOIN zips z ON ST_WITHIN(s.PT, z.g)
          )
          SELECT
            (SELECT ST_ASGEOJSON(ST_SIMPLIFY(area, 100))::STRING FROM u) AS UNION_GEOJSON,
            (SELECT ARRAY_AGG(OBJECT_CONSTRUCT(
               'pid', PID::STRING, 'lon', LON, 'lat', LAT, 'zip', ZIP::STRING,
               'lvl', RISK_LEVEL, 'lbl', RISK_LABEL
             )) FROM samp_risk) AS PARTICIPANTS`;
}

// ---------------------------------------------------------------------------
// Client-side helpers
// ---------------------------------------------------------------------------
export function nearestCenterId(lon: number, lat: number, centers: Center[]): string {
  let best = centers[0]?.centerId ?? '';
  let bestD = Infinity;
  for (const c of centers) {
    const dx = c.lon - lon, dy = c.lat - lat;
    const d = dx * dx + dy * dy;
    if (d < bestD) { bestD = d; best = c.centerId; }
  }
  return best;
}

export type VehicleMeta = {
  physIndex: number;     // physical vehicle (one real van)
  centerId: string;
  vehicleLabel: string;  // "Denver Veh 1"
  tripSlot: number;      // 0-based virtual-trip slot for this physical vehicle
  capacity: number;
};

function shortCenter(name: string): string {
  // "InnovAge Colorado PACE - Denver" -> "Denver"
  const m = name.split(' - ');
  return (m[m.length - 1] || name).replace(/^InnovAge\s+/, '').trim();
}

/**
 * Build a multi-trip VROOM challenge. Each evacuee is a `pickup:[1]` job
 * (collect one person at their home and bring them to the center). Each
 * physical vehicle is expanded into `maxTrips` virtual vehicles that all
 * start/end at the center, so a single solve can route several round trips per
 * van. Total virtual capacity = sum(numVehicles*capacity)*maxTrips; if that is
 * below the evacuee count VROOM leaves the overflow unassigned (reported).
 *
 * Returns { challenge, vehicleMeta, jobParticipant } where vehicleMeta maps a
 * VROOM vehicle id back to its physical vehicle + trip slot for grouping.
 */
export function buildMultiTripChallenge(
  evacuees: Participant[],
  centers: Center[],
  vehicleConfigs: VehicleConfig[],
  maxTrips: number,
): { challenge: any; vehicleMeta: Record<number, VehicleMeta>; jobParticipant: Record<number, string> } {
  const jobs: any[] = [];
  const jobParticipant: Record<number, string> = {};
  evacuees.forEach((p, i) => {
    const id = i + 1;
    jobs.push({ id, location: [p.lon, p.lat], pickup: [1] });
    jobParticipant[id] = p.id;
  });

  const trips = Math.max(1, Math.min(20, Math.floor(maxTrips)));
  const vehicles: any[] = [];
  const vehicleMeta: Record<number, VehicleMeta> = {};
  let vid = 1;
  let physIndex = 0;
  for (const cfg of vehicleConfigs) {
    const c = centers.find(x => x.centerId === cfg.centerId);
    if (!c) continue;
    const cap = Math.max(1, cfg.capacity);
    for (let k = 0; k < cfg.numVehicles; k++) {
      const label = `${shortCenter(c.name)} Veh ${k + 1}`;
      for (let t = 0; t < trips; t++) {
        vehicles.push({
          id: vid,
          profile: 'driving-car',
          start: [c.lon, c.lat],
          end: [c.lon, c.lat],
          capacity: [cap],
        });
        vehicleMeta[vid] = { physIndex, centerId: cfg.centerId, vehicleLabel: label, tripSlot: t, capacity: cap };
        vid++;
      }
      physIndex++;
    }
  }
  return { challenge: { jobs, vehicles }, vehicleMeta, jobParticipant };
}

/**
 * Parse OPTIMIZATION rows into grouped, numbered trips. Each returned vehicle
 * row with >=1 job becomes a PlanTrip; trips are grouped by physical vehicle
 * (via vehicleMeta) and renumbered 1..k in tripSlot order. Stop coordinates
 * come from our own evacuee list (via jobParticipant) so we never depend on
 * VROOM echoing step locations.
 */
export function parseTrips(
  rows: any[],
  evacuees: Participant[],
  vehicleMeta: Record<number, VehicleMeta>,
  jobParticipant: Record<number, string>,
): { trips: PlanTrip[]; assignedCount: number } {
  const byParticipant: Record<string, Participant> = {};
  for (const p of evacuees) byParticipant[p.id] = p;

  type Raw = { meta: VehicleMeta; geojson: any; stops: PlanStop[]; durationSec: number };
  const raws: Raw[] = [];
  const assigned = new Set<number>();

  for (const row of rows) {
    const vid = Number(row.VEHICLE) || 0;
    const meta = vehicleMeta[vid];
    if (!meta) continue;
    let steps: any[] = [];
    try { steps = typeof row.STEPS === 'string' ? JSON.parse(row.STEPS) : (row.STEPS || []); } catch {}
    const jobSteps = steps.filter((s: any) => s.type === 'job' && s.id != null);
    if (!jobSteps.length) continue;
    const stops: PlanStop[] = [];
    jobSteps.forEach((s: any, i: number) => {
      const jobId = Number(s.id);
      assigned.add(jobId);
      const pid = jobParticipant[jobId];
      const p = pid ? byParticipant[pid] : undefined;
      if (p) stops.push({ seq: i + 1, lon: p.lon, lat: p.lat, participantId: p.id });
    });
    let geojson: any = null;
    try { geojson = row.GEOJSON ? (typeof row.GEOJSON === 'string' ? JSON.parse(row.GEOJSON) : row.GEOJSON) : null; } catch {}
    raws.push({ meta, geojson, stops, durationSec: Number(row.DURATION) || 0 });
  }

  // Group by physical vehicle, order trips by tripSlot, renumber 1..k.
  const groups: Record<number, Raw[]> = {};
  for (const r of raws) (groups[r.meta.physIndex] ||= []).push(r);
  const trips: PlanTrip[] = [];
  for (const physIndex of Object.keys(groups).map(Number).sort((a, b) => a - b)) {
    const g = groups[physIndex].sort((a, b) => a.meta.tripSlot - b.meta.tripSlot);
    g.forEach((r, i) => {
      const tripNumber = i + 1;
      trips.push({
        tripKey: `${physIndex}:${tripNumber}`,
        physIndex,
        vehicleLabel: r.meta.vehicleLabel,
        centerId: r.meta.centerId,
        tripNumber,
        geojson: r.geojson,
        stops: r.stops,
        load: r.stops.length,
        capacity: r.meta.capacity,
        durationSec: r.durationSec,
      });
    });
  }
  return { trips, assignedCount: assigned.size };
}

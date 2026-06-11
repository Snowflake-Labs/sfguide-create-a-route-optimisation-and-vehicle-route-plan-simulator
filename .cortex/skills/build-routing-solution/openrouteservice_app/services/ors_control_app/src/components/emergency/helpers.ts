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

export type PlanRoute = {
  vehicleId: number;
  centerId: string;
  geojson: any;          // route LineString
  assignedJobIds: number[];
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
 * Seed participants: sample `numPatients` Overture addresses inside the union
 * of per-center drive-time isochrones, tagged with their ZIP's risk for the
 * active hazard. driveMinutes is passed straight to ORS (minutes semantics).
 */
export function seedSql(stateCode: string, orsRegion: string, hazard: Hazard, numPatients: number, driveMinutes: number): string {
  const lvl = hazard === 'wildfire' ? 'WILDFIRE_LEVEL' : 'FLOOD_LEVEL';
  const lbl = hazard === 'wildfire' ? 'WILDFIRE_LABEL' : 'FLOOD_LABEL';
  const n = Math.max(1, Math.min(1000, Math.floor(numPatients)));
  const mins = Math.max(1, Math.min(60, Math.floor(driveMinutes)));
  return `WITH per_center AS (
            SELECT CENTER_ID,
                   EMERGENCY_RESPONSE.CORE.ORS_ISOCHRONE_FOR_CENTER(LOC, ${mins}, ${sqlStr(orsRegion)}) AS iso
            FROM EMERGENCY_RESPONSE.CORE.INNOVAGE_CENTERS
            WHERE STATE = ${sqlStr(stateCode)}
          ),
          u AS (SELECT ST_UNION_AGG(iso) AS area FROM per_center WHERE iso IS NOT NULL),
          samp AS (
            SELECT a.ID AS PID, a.POSTCODE AS ZIP,
                   ST_X(a.GEOMETRY) AS LON, ST_Y(a.GEOMETRY) AS LAT
            FROM OVERTURE_MAPS__ADDRESSES.CARTO.ADDRESS a, u
            WHERE a.COUNTRY = 'US'
              AND a.POSTCODE IS NOT NULL
              AND ST_WITHIN(a.GEOMETRY, u.area)
            ORDER BY RANDOM()
            LIMIT ${n}
          )
          SELECT s.PID, s.LON, s.LAT, s.ZIP,
                 COALESCE(r.${lvl}, 0) AS RISK_LEVEL,
                 COALESCE(r.${lbl}, 'No Rating') AS RISK_LABEL
          FROM samp s
          LEFT JOIN EMERGENCY_RESPONSE.PIPELINE.V_ZIP_RISK r
            ON r.ZIP_CODE = s.ZIP AND r.STATE = ${sqlStr(stateCode)}`;
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

/**
 * Build the VROOM challenge from evacuees (jobs) + per-center vehicle fleets.
 * Returns { challenge, vehicleCenter } where vehicleCenter maps a VROOM vehicle
 * id back to its origin center so routes can be colored/attributed per center.
 */
export function buildVroomChallenge(
  evacuees: Participant[],
  centers: Center[],
  vehicleConfigs: VehicleConfig[],
): { challenge: any; vehicleCenter: Record<number, string>; jobParticipant: Record<number, string> } {
  const jobs: any[] = [];
  const jobParticipant: Record<number, string> = {};
  evacuees.forEach((p, i) => {
    const id = i + 1;
    jobs.push({ id, location: [p.lon, p.lat], delivery: [1] });
    jobParticipant[id] = p.id;
  });

  const vehicles: any[] = [];
  const vehicleCenter: Record<number, string> = {};
  let vid = 1;
  for (const cfg of vehicleConfigs) {
    const c = centers.find(x => x.centerId === cfg.centerId);
    if (!c) continue;
    for (let k = 0; k < cfg.numVehicles; k++) {
      vehicles.push({
        id: vid,
        profile: 'driving-car',
        start: [c.lon, c.lat],
        end: [c.lon, c.lat],
        capacity: [Math.max(1, cfg.capacity)],
      });
      vehicleCenter[vid] = cfg.centerId;
      vid++;
    }
  }
  return { challenge: { jobs, vehicles }, vehicleCenter, jobParticipant };
}

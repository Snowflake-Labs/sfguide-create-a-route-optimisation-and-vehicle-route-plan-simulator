// Vehicle-type parameter catalog — the single source of truth for per-mode
// asset dimensions and evaluation thresholds (dwell SLA, route-deviation ratio,
// GPS teleport distance).
//
// WHY THIS EXISTS
// Before this module, per-vehicle-type knowledge was scattered across three
// disconnected places: generation knobs in profiles.ts (TS-only, never
// persisted), faked HGV dimensions via `CASE WHEN OPERATING_MODE='regional_hgv'`
// in route-optimization/references/extend-dim-fleet-hgv.sql (a branching
// anti-pattern), and evaluation thresholds hardcoded as SQL literals
// (deviation 0.20, teleport 2000m) or keyed only by LOCATION_TYPE
// (SLA_THRESHOLDS). None of it was a shared catalog the SA_APP could read.
//
// This catalog persists all of it into FLEET_INTELLIGENCE.CORE keyed by
// VEHICLE_TYPE. The Data Studio generator stamps DIM_FLEET asset columns by
// LOOKING UP the selected type's row (no code/SQL branches on vehicle type),
// and the SA_APP dwell / route_deviation packs JOIN the catalog on the active
// dataset's VEHICLE_TYPE for their thresholds. Onboarding a new mode
// (vessel / aircraft) becomes a single catalog row + data — zero code change.
//
// The orsProfile / operatingMode are sourced from profiles.ts PROFILE_TEMPLATES
// so they never drift; the asset dimensions and thresholds are NEW knowledge
// defined here (this module is their source of truth).

import { PROFILE_TEMPLATES, VehicleType } from './profiles.js';

type SnowSqlFn = (sql: string, database?: string, schema?: string) => Promise<any[]>;

const TRACK = `{"origin":"sf_sit-is-fleet","name":"oss-build-routing-solution","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}`;

export interface SubtypeShare {
  subtype: string;
  pct: number; // integer percentage; pcts across the array sum to 100
}

export interface DwellSlaRow {
  locationType: string;
  warningMin: number;
  criticalMin: number;
  bufferRadiusM: number;
}

export interface VehicleProfileRow {
  vehicleType: VehicleType;
  orsProfile: string;
  operatingMode: string;
  // Sparse asset attributes (union of all modes; modes that lack an attribute
  // carry a light default, never NULL-vs-branch). Stamped onto DIM_FLEET.
  weightTons: number;
  heightM: number;
  lengthM: number;
  widthM: number;
  axleloadT: number;
  // Probability that a vehicle of TANKER subtype carries hazmat. 0 for modes
  // with no subtype distribution.
  hazmatProb: number;
  // HASH-bucket distribution for VEHICLE_SUBTYPE. null => subtype is NULL for
  // this mode (e.g. car / ebike have no trailer subtype).
  subtypeDist: SubtypeShare[] | null;
  // Evaluation thresholds consumed by the SA_APP analytics packs.
  deviationDistanceRatio: number; // fraction over expected distance that flags a deviation
  teleportDistanceM: number;      // GPS jump (m) between consecutive pings that flags a teleport
  dwellSla: DwellSlaRow[];         // per LOCATION_TYPE warn/critical minutes + geofence buffer
}

// Baseline dwell SLA (tuned for HGV / route-deviation, the historical
// SLA_THRESHOLDS values) + geofence buffer radii. Lighter modes scale the
// minute thresholds down by DWELL_SCALE; IDLE is never scaled (a long idle is
// anomalous for any mode) and buffer radii are mode-independent.
const BASELINE_DWELL_SLA: DwellSlaRow[] = [
  { locationType: 'WAREHOUSE',   warningMin: 5,   criticalMin: 15,  bufferRadiusM: 200 },
  { locationType: 'DESTINATION', warningMin: 3,   criticalMin: 10,  bufferRadiusM: 100 },
  { locationType: 'REST_STOP',   warningMin: 5,   criticalMin: 12,  bufferRadiusM: 150 },
  { locationType: 'STORE',       warningMin: 2,   criticalMin: 8,   bufferRadiusM: 100 },
  { locationType: 'DETOUR',      warningMin: 2,   criticalMin: 5,   bufferRadiusM: 100 },
  { locationType: 'IDLE',        warningMin: 120, criticalMin: 240, bufferRadiusM: 100 },
];

const DWELL_SCALE: Record<VehicleType, number> = { hgv: 1.0, car: 0.6, ebike: 0.5 };

function scaledDwellSla(vehicleType: VehicleType): DwellSlaRow[] {
  const f = DWELL_SCALE[vehicleType] ?? 1.0;
  return BASELINE_DWELL_SLA.map((r) => {
    if (r.locationType === 'IDLE') return { ...r }; // idle thresholds are mode-independent
    const warn = Math.max(1, Math.round(r.warningMin * f));
    const crit = Math.max(warn + 1, Math.round(r.criticalMin * f));
    return { locationType: r.locationType, warningMin: warn, criticalMin: crit, bufferRadiusM: r.bufferRadiusM };
  });
}

function orsProfileFor(vt: VehicleType): string {
  return PROFILE_TEMPLATES.find((t) => t.vehicleType === vt)?.orsProfile ?? 'driving-car';
}
function operatingModeFor(vt: VehicleType): string {
  return (PROFILE_TEMPLATES.find((t) => t.vehicleType === vt)?.defaultConfig.mode) ?? 'unknown';
}

// Asset-dimension + threshold knowledge per mode. HGV values mirror the
// historical extend-dim-fleet-hgv.sql trucking defaults; car/ebike carry light
// realistic dimensions (no CASE branch — the row IS the per-mode answer).
const ASSET_SPEC: Record<VehicleType, {
  weightTons: number; heightM: number; lengthM: number; widthM: number; axleloadT: number;
  hazmatProb: number; subtypeDist: SubtypeShare[] | null;
  deviationDistanceRatio: number; teleportDistanceM: number;
}> = {
  hgv: {
    weightTons: 40.0, heightM: 4.00, lengthM: 16.50, widthM: 2.55, axleloadT: 11.50,
    hazmatProb: 0.18, // of TANKER subtype vehicles (matches legacy bucket-99 share)
    subtypeDist: [
      { subtype: 'DRY', pct: 60 },
      { subtype: 'REEFER', pct: 25 },
      { subtype: 'FLAT', pct: 12 },
      { subtype: 'TANKER', pct: 3 },
    ],
    deviationDistanceRatio: 0.25, teleportDistanceM: 2500,
  },
  car: {
    weightTons: 2.0, heightM: 2.00, lengthM: 4.50, widthM: 1.85, axleloadT: 1.20,
    hazmatProb: 0, subtypeDist: null,
    deviationDistanceRatio: 0.20, teleportDistanceM: 1000,
  },
  ebike: {
    weightTons: 0.1, heightM: 1.20, lengthM: 1.80, widthM: 0.70, axleloadT: 0.05,
    hazmatProb: 0, subtypeDist: null,
    deviationDistanceRatio: 0.15, teleportDistanceM: 300,
  },
};

export const VEHICLE_PROFILE_CATALOG: VehicleProfileRow[] = (Object.keys(ASSET_SPEC) as VehicleType[]).map((vt) => {
  const a = ASSET_SPEC[vt];
  return {
    vehicleType: vt,
    orsProfile: orsProfileFor(vt),
    operatingMode: operatingModeFor(vt),
    weightTons: a.weightTons, heightM: a.heightM, lengthM: a.lengthM, widthM: a.widthM, axleloadT: a.axleloadT,
    hazmatProb: a.hazmatProb, subtypeDist: a.subtypeDist,
    deviationDistanceRatio: a.deviationDistanceRatio, teleportDistanceM: a.teleportDistanceM,
    dwellSla: scaledDwellSla(vt),
  };
});

export function vehicleProfileFor(vehicleType: string): VehicleProfileRow | undefined {
  return VEHICLE_PROFILE_CATALOG.find((r) => r.vehicleType === vehicleType);
}

const PROFILE_DDL = `CREATE TABLE IF NOT EXISTS FLEET_INTELLIGENCE.CORE.DIM_VEHICLE_PROFILE (
  VEHICLE_TYPE             VARCHAR PRIMARY KEY,
  ORS_PROFILE             VARCHAR  NOT NULL,
  OPERATING_MODE          VARCHAR  NOT NULL,
  WEIGHT_TONS             NUMBER(6,2),
  HEIGHT_M                NUMBER(4,2),
  LENGTH_M                NUMBER(4,2),
  WIDTH_M                 NUMBER(4,2),
  AXLELOAD_T              NUMBER(4,2),
  HAZMAT_PROB             FLOAT,
  SUBTYPE_DIST            VARIANT,
  DEVIATION_DISTANCE_RATIO FLOAT   NOT NULL,
  TELEPORT_DISTANCE_M     NUMBER   NOT NULL
) COMMENT = '${TRACK}'`;

const DWELL_SLA_DDL = `CREATE TABLE IF NOT EXISTS FLEET_INTELLIGENCE.CORE.DIM_VEHICLE_DWELL_SLA (
  VEHICLE_TYPE    VARCHAR NOT NULL,
  LOCATION_TYPE   VARCHAR NOT NULL,
  WARNING_MIN     NUMBER  NOT NULL,
  CRITICAL_MIN    NUMBER  NOT NULL,
  BUFFER_RADIUS_M NUMBER  NOT NULL
) COMMENT = '${TRACK}'`;

function profileMergeSql(): string {
  const rows = VEHICLE_PROFILE_CATALOG.map((r) => {
    const dist = r.subtypeDist ? `PARSE_JSON($$${JSON.stringify(r.subtypeDist)}$$)` : 'NULL';
    return `SELECT '${r.vehicleType}' AS VEHICLE_TYPE, '${r.orsProfile}' AS ORS_PROFILE, '${r.operatingMode}' AS OPERATING_MODE, ` +
      `${r.weightTons} AS WEIGHT_TONS, ${r.heightM} AS HEIGHT_M, ${r.lengthM} AS LENGTH_M, ${r.widthM} AS WIDTH_M, ${r.axleloadT} AS AXLELOAD_T, ` +
      `${r.hazmatProb} AS HAZMAT_PROB, ${dist} AS SUBTYPE_DIST, ${r.deviationDistanceRatio} AS DEVIATION_DISTANCE_RATIO, ${r.teleportDistanceM} AS TELEPORT_DISTANCE_M`;
  }).join('\n      UNION ALL ');
  // MERGE updates existing rows too, so re-tuned defaults propagate on next boot.
  return `MERGE INTO FLEET_INTELLIGENCE.CORE.DIM_VEHICLE_PROFILE tgt
    USING (
      ${rows}
    ) src
    ON tgt.VEHICLE_TYPE = src.VEHICLE_TYPE
    WHEN MATCHED THEN UPDATE SET
      ORS_PROFILE = src.ORS_PROFILE, OPERATING_MODE = src.OPERATING_MODE,
      WEIGHT_TONS = src.WEIGHT_TONS, HEIGHT_M = src.HEIGHT_M, LENGTH_M = src.LENGTH_M,
      WIDTH_M = src.WIDTH_M, AXLELOAD_T = src.AXLELOAD_T, HAZMAT_PROB = src.HAZMAT_PROB,
      SUBTYPE_DIST = src.SUBTYPE_DIST, DEVIATION_DISTANCE_RATIO = src.DEVIATION_DISTANCE_RATIO,
      TELEPORT_DISTANCE_M = src.TELEPORT_DISTANCE_M
    WHEN NOT MATCHED THEN INSERT (VEHICLE_TYPE, ORS_PROFILE, OPERATING_MODE, WEIGHT_TONS, HEIGHT_M, LENGTH_M, WIDTH_M, AXLELOAD_T, HAZMAT_PROB, SUBTYPE_DIST, DEVIATION_DISTANCE_RATIO, TELEPORT_DISTANCE_M)
      VALUES (src.VEHICLE_TYPE, src.ORS_PROFILE, src.OPERATING_MODE, src.WEIGHT_TONS, src.HEIGHT_M, src.LENGTH_M, src.WIDTH_M, src.AXLELOAD_T, src.HAZMAT_PROB, src.SUBTYPE_DIST, src.DEVIATION_DISTANCE_RATIO, src.TELEPORT_DISTANCE_M)`;
}

function dwellSlaMergeSql(): string {
  const rows: string[] = [];
  for (const r of VEHICLE_PROFILE_CATALOG) {
    for (const s of r.dwellSla) {
      rows.push(`SELECT '${r.vehicleType}' AS VEHICLE_TYPE, '${s.locationType}' AS LOCATION_TYPE, ${s.warningMin} AS WARNING_MIN, ${s.criticalMin} AS CRITICAL_MIN, ${s.bufferRadiusM} AS BUFFER_RADIUS_M`);
    }
  }
  return `MERGE INTO FLEET_INTELLIGENCE.CORE.DIM_VEHICLE_DWELL_SLA tgt
    USING (
      ${rows.join('\n      UNION ALL ')}
    ) src
    ON tgt.VEHICLE_TYPE = src.VEHICLE_TYPE AND tgt.LOCATION_TYPE = src.LOCATION_TYPE
    WHEN MATCHED THEN UPDATE SET
      WARNING_MIN = src.WARNING_MIN, CRITICAL_MIN = src.CRITICAL_MIN, BUFFER_RADIUS_M = src.BUFFER_RADIUS_M
    WHEN NOT MATCHED THEN INSERT (VEHICLE_TYPE, LOCATION_TYPE, WARNING_MIN, CRITICAL_MIN, BUFFER_RADIUS_M)
      VALUES (src.VEHICLE_TYPE, src.LOCATION_TYPE, src.WARNING_MIN, src.CRITICAL_MIN, src.BUFFER_RADIUS_M)`;
}

// Idempotent: CREATE TABLE IF NOT EXISTS + MERGE (upsert). Safe to call on
// every boot. Must run BEFORE any contract view/UDTF that reads the catalog
// and before generation stamps DIM_FLEET.
export async function ensureVehicleProfileCatalog(snowSql: SnowSqlFn): Promise<void> {
  const stmts = [PROFILE_DDL, profileMergeSql(), DWELL_SLA_DDL, dwellSlaMergeSql()];
  for (const sql of stmts) {
    await snowSql(sql, 'FLEET_INTELLIGENCE', 'CORE');
  }
}

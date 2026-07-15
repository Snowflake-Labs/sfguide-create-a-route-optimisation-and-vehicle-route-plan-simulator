// Universal-generation engine: participant/passenger locations.
//
// Participants are a raw sample of real Overture residential buildings within a
// straight-line radius (participant_radius_km, via ST_DWITHIN) of the region's
// HEALTH_FACILITY anchors. Building centroids (SUBTYPE='residential') are used
// as the household proxy for EVERY region: Overture Buildings has global
// coverage, whereas Overture Addresses is US-biased and empty for many regions
// (e.g. the UK), which would leave DIM_PARTICIPANTS empty there. One unified
// source, one code path, all regions - no per-region branching. They replace the
// runtime random-point sampling that TOOL_EVAC_SEED used to do: the persisted raw
// sample is generated here at build time, and the emergency-response wizard's
// isochrone step filters it at demo time.
//
// Design mirrors engine/anchors.ts: a single server-side INSERT...SELECT straight
// from Overture (no Node row marshalling). Reads the centers just inserted for
// this run (same JOB_ID) so it MUST run after generateAnchors. All rows carry the
// run's JOB_ID for dataset versioning.

import type { SnowSqlFn } from './types';
import type { GenerationConfig } from '../profiles';
import { log } from '../../diagnostics';
import { sqlLit } from './region-source';

const UNIFIED = 'SYNTHETIC_DATASETS.UNIFIED';
const ANCHORS = `${UNIFIED}.DIM_ANCHORS`;
const PARTICIPANTS = `${UNIFIED}.DIM_PARTICIPANTS`;
const BUILDINGS = 'OVERTURE_MAPS__BUILDINGS.CARTO.BUILDING';
const PARTICIPANT_COLS =
  '(PARTICIPANT_ID,REGION,LAT,LNG,GEOM,ADDRESS,CITY,STATE,POSTCODE,NEAREST_ANCHOR_ID,SOURCE,JOB_ID)';

const DEFAULT_RADIUS_KM = 50;
const DEFAULT_SAMPLE_SIZE = 3000;

/**
 * Generate participant/passenger locations for the active region into
 * DIM_PARTICIPANTS. Samples real Overture residential building centroids within
 * participant_radius_km of this run's HEALTH_FACILITY anchors and tags each with
 * its nearest center. Uses Overture Buildings for every region (global coverage);
 * Overture Addresses is not used. Returns the number of participant rows inserted.
 */
export async function generateParticipants(
  config: GenerationConfig,
  snowSql: SnowSqlFn,
  jobId: string,
): Promise<number> {
  const region = sqlLit(config.region);
  const radiusKm = Number.isFinite(config.participant_radius_km) && (config.participant_radius_km as number) > 0
    ? (config.participant_radius_km as number)
    : DEFAULT_RADIUS_KM;
  const radiusM = Math.round(radiusKm * 1000);
  const sampleSize = Number.isFinite(config.participant_sample_size) && (config.participant_sample_size as number) > 0
    ? Math.floor(config.participant_sample_size as number)
    : DEFAULT_SAMPLE_SIZE;

  // 1. centers: the HEALTH_FACILITY anchors generated for THIS run.
  // 2. cand: Overture residential buildings spatially joined to the centers
  //    within radiusM (on the building centroid), deduped to the nearest center
  //    per building (QUALIFY rn=1) -> also yields NEAREST_ANCHOR_ID. A correlated
  //    EXISTS with a spatial predicate cannot be decorrelated by Snowflake
  //    ("Unsupported subquery type"), so this MUST be a spatial JOIN, not
  //    WHERE EXISTS(... ST_DWITHIN ...).
  // 3. samp: random subsample down to sampleSize distinct buildings.
  const sql = `
    INSERT INTO ${PARTICIPANTS} ${PARTICIPANT_COLS}
    WITH centers AS (
      SELECT ANCHOR_ID, GEOM
      FROM ${ANCHORS}
      WHERE REGION = ${region}
        AND JOB_ID = ${sqlLit(jobId)}
        AND ANCHOR_TYPE = 'HEALTH_FACILITY'
        AND GEOM IS NOT NULL
    ),
    cand AS (
      SELECT b.ID AS AID, ST_CENTROID(b.GEOMETRY) AS G,
             b.NAMES:primary::string AS NM,
             c.ANCHOR_ID AS NEAREST
      FROM ${BUILDINGS} b
      JOIN centers c ON ST_DWITHIN(ST_CENTROID(b.GEOMETRY), c.GEOM, ${radiusM})
      WHERE b.GEOMETRY IS NOT NULL AND b.SUBTYPE = 'residential'
      QUALIFY ROW_NUMBER() OVER (PARTITION BY b.ID ORDER BY ST_DISTANCE(ST_CENTROID(b.GEOMETRY), c.GEOM)) = 1
    ),
    samp AS (
      SELECT * FROM cand ORDER BY RANDOM() LIMIT ${sampleSize}
    )
    SELECT
      AID,
      ${region},
      ST_Y(G), ST_X(G), G,
      NM,
      NULL,
      NULL,
      NULL,
      NEAREST,
      'overture_buildings',
      ${sqlLit(jobId)}
    FROM samp`;
  try {
    const rows = await snowSql(sql, 'OVERTURE_MAPS__BUILDINGS', 'CARTO');
    const n = Number(rows?.[0]?.['number of rows inserted'] ?? rows?.[0]?.['rows_inserted'] ?? 0);
    return Number.isFinite(n) ? n : 0;
  } catch (e: any) {
    log('WARN', 'Studio', `DIM_PARTICIPANTS generation failed (non-fatal): ${e.message?.slice(0, 200)}`, { jobId });
    return 0;
  }
}

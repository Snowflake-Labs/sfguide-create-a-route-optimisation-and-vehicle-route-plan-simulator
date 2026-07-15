import { NextResponse } from 'next/server';
import { withLogging } from '@/lib/api-handler';
import { runSql } from '@/server/lib/sql';
import { escapeString } from '@/server/lib/sanitize';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const VEHICLE_TYPE_TO_ORS_PROFILE: Record<string, string> = {
  ebike: 'cycling-electric', hgv: 'driving-hgv', car: 'driving-car',
};

async function resolveOrsProfile(vehicleType: string, activeDatasetId: string | null): Promise<string> {
  if (activeDatasetId) {
    try {
      const rows = await runSql(
        `SELECT j.ORS_PROFILE FROM FLEET_INTELLIGENCE.CORE.GENERATION_JOBS j WHERE j.JOB_ID = '${escapeString(activeDatasetId)}' LIMIT 1`,
        'FLEET_INTELLIGENCE', 'CORE',
      );
      const fromJob = (rows[0] as { ORS_PROFILE?: string })?.ORS_PROFILE;
      if (fromJob) return String(fromJob);
    } catch {}
  }
  try {
    const rows = await runSql(
      `SELECT ORS_PROFILE FROM OPENROUTESERVICE_APP.CORE.VEHICLE_CLASS_PROFILE WHERE VEHICLE_TYPE = '${escapeString(vehicleType)}' LIMIT 1`,
      'OPENROUTESERVICE_APP', 'CORE',
    );
    const fromClass = (rows[0] as { ORS_PROFILE?: string })?.ORS_PROFILE;
    if (fromClass) return String(fromClass);
  } catch {}
  return VEHICLE_TYPE_TO_ORS_PROFILE[vehicleType] || 'driving-car';
}

export const GET = withLogging(async () => {
  try {
    let vehicleType = 'ebike';
    let region = 'SanFrancisco';
    try {
      const rows = await runSql('SELECT VEHICLE_TYPE, REGION FROM FLEET_INTELLIGENCE.DWELL_ANALYSIS.CONFIG LIMIT 1');
      if (rows?.[0]) { vehicleType = rows[0].VEHICLE_TYPE || vehicleType; region = rows[0].REGION || region; }
    } catch {}
    let activeDatasetId: string | null = null;
    try {
      const dsRows = await runSql(
        `SELECT DATASET_ID FROM FLEET_INTELLIGENCE.CORE.DIM_DATASETS
         WHERE REGION = '${escapeString(region)}' AND VEHICLE_TYPE = '${escapeString(vehicleType)}' AND IS_ACTIVE = TRUE LIMIT 1`,
        'FLEET_INTELLIGENCE', 'CORE',
      );
      if (dsRows?.[0]) activeDatasetId = (dsRows[0] as { DATASET_ID?: string }).DATASET_ID ?? null;
    } catch {}
    let availableTypes: string[] = [];
    let datasetPairs: { vehicleType: string; region: string }[] = [];
    try {
      const rows = await runSql('SELECT DISTINCT VEHICLE_TYPE, REGION FROM SYNTHETIC_DATASETS.UNIFIED.V_FACT_TRIPS_CURRENT ORDER BY VEHICLE_TYPE, REGION');
      datasetPairs = rows.map((r) => ({ vehicleType: r.VEHICLE_TYPE, region: r.REGION })).filter((p) => p.vehicleType && p.region);
      availableTypes = [...new Set(datasetPairs.map((p) => p.vehicleType))];
    } catch {}
    if (vehicleType && !availableTypes.includes(vehicleType)) availableTypes.push(vehicleType);
    if (availableTypes.length === 0) availableTypes = [vehicleType];
    const orsProfile = await resolveOrsProfile(vehicleType, activeDatasetId);
    return NextResponse.json({ vehicleType, region, orsProfile, availableTypes, datasetPairs, activeDatasetId });
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }
});

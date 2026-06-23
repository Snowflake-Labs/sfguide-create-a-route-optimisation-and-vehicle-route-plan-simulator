import { NextResponse } from 'next/server';
import { withLogging } from '@/lib/api-handler';
import { SF_DATABASE } from '@/server/constants';
import { runSql } from '@/server/lib/sql';
import { sanitizeIdentifier, escapeString } from '@/server/lib/sanitize';
import { orsServiceName } from '@/server/lib/region';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const GET = withLogging(async () => {
  try {
    const orsRegions = await runSql(`SELECT * FROM ${SF_DATABASE}.CORE.REGION_ORS_MAP`);
    const catalogAreas: Record<string, number> = {};
    try {
      const rows = await runSql(`SELECT UPPER(REGION_KEY) AS K1, UPPER(LOOKUP_NAME) AS K2, BOUNDARY_AREA_KM2 AS A FROM ${SF_DATABASE}.CORE.REGION_CATALOG WHERE BOUNDARY IS NOT NULL AND BOUNDARY_AREA_KM2 > 0`);
      for (const r of rows || []) {
        const a = Number(r.A);
        if (r.K1) catalogAreas[r.K1] = a;
        if (r.K2 && !catalogAreas[r.K2]) catalogAreas[r.K2] = a;
      }
    } catch {}
    const regions: Record<string, unknown>[] = [];
    for (const c of orsRegions) {
      const safeRegion = sanitizeIdentifier(c.REGION || '');
      let serviceStatus = 'NOT_FOUND';
      try {
        const rows = await runSql(`SHOW SERVICES LIKE '${orsServiceName(safeRegion)}' IN SCHEMA ${SF_DATABASE}.CORE`);
        serviceStatus = rows?.[0]?.status || 'NOT_FOUND';
      } catch {}
      const upperRegion = (c.REGION || '').toUpperCase();
      regions.push({
        region: c.REGION, label: c.DISPLAY_NAME || c.REGION,
        bounds: { minLat: Number(c.MIN_LAT), maxLat: Number(c.MAX_LAT), minLon: Number(c.MIN_LON), maxLon: Number(c.MAX_LON) },
        boundaryAreaKm2: catalogAreas[upperRegion] ?? null,
        serviceStatus, serviceExists: serviceStatus !== 'NOT_FOUND',
        matrixFunctionExists: true, directionsFunctionExists: true,
        ready: serviceStatus === 'RUNNING' || serviceStatus === 'SUSPENDED',
        provisioned: true, matrixFn: `${SF_DATABASE}.CORE.MATRIX_TABULAR`, labels: [c.DISPLAY_NAME || c.REGION],
      });
    }
    let mainStatus = 'NOT_FOUND';
    try {
      const rows = await runSql(`SHOW SERVICES LIKE 'ORS_SERVICE_SANFRANCISCO' IN SCHEMA ${SF_DATABASE}.CORE`);
      mainStatus = rows?.[0]?.status || 'NOT_FOUND';
    } catch {}
    if (mainStatus !== 'NOT_FOUND') {
      let defaultRegion = 'DEFAULT', defaultLabel = 'Default ORS';
      let defaultBounds = { minLat: 37.71, maxLat: 37.81, minLon: -122.51, maxLon: -122.37 };
      try {
        const stageRows = await runSql(`LIST @${SF_DATABASE}.CORE.ORS_SPCS_STAGE PATTERN='.*ors-config.*'`);
        const knownRegions = new Set(orsRegions.map((c) => (c.REGION || '').toUpperCase()));
        for (const row of stageRows || []) {
          const path = row.name || row.NAME || '';
          const match = path.match(/ors_spcs_stage\/([^/]+)\/ors-config/i);
          if (match && !knownRegions.has(match[1].toUpperCase())) { defaultRegion = match[1]; defaultLabel = match[1].replace(/([a-z])([A-Z])/g, '$1 $2'); break; }
        }
      } catch {}
      try {
        const regionRow = await runSql(`SELECT * FROM ${SF_DATABASE}.CORE.REGION_ORS_MAP WHERE REGION = '${escapeString(defaultRegion)}'`);
        if (regionRow?.[0]) { defaultLabel = regionRow[0].DISPLAY_NAME || defaultLabel; defaultBounds = { minLat: Number(regionRow[0].MIN_LAT), maxLat: Number(regionRow[0].MAX_LAT), minLon: Number(regionRow[0].MIN_LON), maxLon: Number(regionRow[0].MAX_LON) }; }
      } catch {}
      regions.unshift({
        region: defaultRegion, label: `${defaultLabel} (Default)`, bounds: defaultBounds,
        boundaryAreaKm2: catalogAreas[defaultRegion.toUpperCase()] ?? null,
        serviceStatus: mainStatus, serviceExists: true, matrixFunctionExists: true, directionsFunctionExists: true,
        ready: mainStatus === 'RUNNING' || mainStatus === 'SUSPENDED', provisioned: true,
        matrixFn: `${SF_DATABASE}.CORE.MATRIX_TABULAR`, labels: [defaultLabel], isDefault: true,
      });
    }
    return NextResponse.json({ regions });
  } catch (err) {
    return NextResponse.json({ regions: [], error: (err as Error).message });
  }
});

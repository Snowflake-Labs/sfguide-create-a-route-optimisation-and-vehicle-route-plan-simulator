import { NextResponse } from 'next/server';
import { withLogging } from '@/lib/api-handler';
import { SF_DATABASE } from '@/server/constants';
import { runSql, callProcedure } from '@/server/lib/sql';
import { sanitizeIdentifier } from '@/server/lib/sanitize';
import { orsServiceName } from '@/server/lib/region';
import { getExpectedProfiles } from '@/server/lib/ors';
import { regionCatalogMatch } from '@/server/lib/region-catalog-match';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const GET = withLogging(async () => {
  try {
    const result = await callProcedure('LIST_REGIONS()');
    const regions = JSON.parse(result || '[]');
    const enriched = await Promise.all(regions.map(async (c: Record<string, unknown>) => {
      let serviceStatus = 'UNKNOWN';
      try {
        const rows = await runSql(`SHOW SERVICES LIKE '${orsServiceName(c.region as string)}' IN SCHEMA ${SF_DATABASE}.CORE`);
        serviceStatus = rows?.[0]?.status || 'NOT_FOUND';
      } catch { serviceStatus = 'NOT_FOUND'; }

      let bbox = c.bbox as { min_lat?: number; max_lat?: number; min_lon?: number; max_lon?: number } | undefined;
      let boundaryGeoJson: string | null = null;
      const bboxInvalid = !bbox || bbox.min_lat == null || bbox.max_lat == null || bbox.min_lon == null || bbox.max_lon == null
        || (bbox.min_lat === 0 && bbox.max_lat === 0 && bbox.min_lon === 0 && bbox.max_lon === 0);
      try {
        const safeRegion = sanitizeIdentifier(c.region as string);
        const m = regionCatalogMatch('', `'${safeRegion}'`);
        const catRows = await runSql(`SELECT MIN_LAT, MAX_LAT, MIN_LON, MAX_LON, CAST(ST_ASGEOJSON(BOUNDARY) AS VARCHAR) AS BOUNDARY_GEOJSON FROM ${SF_DATABASE}.CORE.REGION_CATALOG WHERE ${m.predicate} ORDER BY ${m.rank} LIMIT 1`);
        const cat = catRows?.[0];
        if (cat) {
          const catBboxOk = cat.MIN_LAT != null && cat.MAX_LAT != null && cat.MIN_LON != null && cat.MAX_LON != null
            && !(cat.MIN_LAT === 0 && cat.MAX_LAT === 0 && cat.MIN_LON === 0 && cat.MAX_LON === 0);
          if (bboxInvalid && catBboxOk) {
            bbox = { min_lat: cat.MIN_LAT, max_lat: cat.MAX_LAT, min_lon: cat.MIN_LON, max_lon: cat.MAX_LON };
          } else if (catBboxOk && bbox && cat.MIN_LAT <= bbox.min_lat! && cat.MAX_LAT >= bbox.max_lat!
                     && cat.MIN_LON <= bbox.min_lon! && cat.MAX_LON >= bbox.max_lon!) {
            bbox = { min_lat: cat.MIN_LAT, max_lat: cat.MAX_LAT, min_lon: cat.MIN_LON, max_lon: cat.MAX_LON };
          }
          if (cat.BOUNDARY_GEOJSON) boundaryGeoJson = cat.BOUNDARY_GEOJSON;
        }
      } catch {}

      let graphReadiness: unknown = null;
      if (serviceStatus === 'RUNNING' || serviceStatus === 'READY') {
        try {
          const safeRegion = sanitizeIdentifier(c.region as string);
          const orsRows = await runSql(`SELECT TO_VARCHAR(${SF_DATABASE}.CORE.ORS_STATUS('${safeRegion}')) AS S`);
          const raw = orsRows?.[0]?.S;
          if (raw) {
            const data = typeof raw === 'string' ? JSON.parse(raw) : raw;
            const builtProfiles = Object.keys(data.profiles || {});
            const expectedProfiles = await getExpectedProfiles(c.region as string);
            const allProfiles = [...new Set([...expectedProfiles, ...builtProfiles])];
            graphReadiness = {
              service_ready: data.service_ready ?? false,
              profiles_loaded: builtProfiles,
              expected_profiles: expectedProfiles,
              graphs: allProfiles.map((p: string) => ({ profile: p, ready: builtProfiles.includes(p), build_date: (data.bounds_info || {})[p]?.graph_build_date || null })),
            };
          }
        } catch (e) {
          graphReadiness = { service_ready: false, error: (e as Error).message, profiles_loaded: [], expected_profiles: [], graphs: [] };
        }
      }
      return { ...c, isDefault: c.is_default === true, bbox, boundaryGeoJson, serviceStatus, functionExists: true, graphReadiness };
    }));
    return NextResponse.json({ regions: enriched });
  } catch (err) {
    return NextResponse.json({ regions: [], error: (err as Error).message });
  }
});

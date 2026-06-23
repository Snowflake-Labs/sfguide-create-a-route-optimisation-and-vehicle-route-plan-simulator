import { NextResponse } from 'next/server';
import { withLogging } from '@/lib/api-handler';
import { SF_DATABASE } from '@/server/constants';
import { runSql } from '@/server/lib/sql';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const GET = withLogging(async () => {
  try {
    const roadFilterMap: Record<string, boolean> = {};
    try {
      const rfRows = await runSql(
        `SELECT REGION, PROFILE, RESOLUTION, ROAD_FILTER AS RF FROM (
           SELECT REGION, PROFILE, RESOLUTION, ROAD_FILTER,
                  ROW_NUMBER() OVER (PARTITION BY REGION, PROFILE, RESOLUTION ORDER BY COMPLETED_AT DESC NULLS LAST) AS RN
           FROM ${SF_DATABASE}.TRAVEL_MATRIX.MATRIX_BUILD_JOBS WHERE STATUS = 'COMPLETE'
         ) WHERE RN = 1`,
      );
      for (const r of rfRows || []) {
        const key = `${(r.REGION || '').toUpperCase()}_${(r.PROFILE || '').replace(/-/g, '_').toUpperCase()}_${r.RESOLUTION}`;
        roadFilterMap[key] = r.RF === true || r.RF === 'true';
      }
    } catch {}
    let inventory: unknown[] = [];
    try {
      const rows = await runSql(
        `SELECT TABLE_NAME, ROW_COUNT, BYTES, TO_VARCHAR(CREATED::TIMESTAMP_LTZ, 'YYYY-MM-DD"T"HH24:MI:SS.FF3TZH:TZM') AS CREATED
         FROM ${SF_DATABASE}.INFORMATION_SCHEMA.TABLES
         WHERE TABLE_SCHEMA = 'TRAVEL_MATRIX' AND TABLE_NAME LIKE '%_MATRIX_RES%' AND ROW_COUNT > 0
         ORDER BY CREATED DESC`,
      );
      inventory = (rows || []).map((t) => {
        const name = (t.TABLE_NAME || '').toUpperCase();
        const parts = name.match(/^(.+?)_(DRIVING_CAR|DRIVING_HGV|CYCLING_ROAD|CYCLING_REGULAR|CYCLING_ELECTRIC|FOOT_WALKING|FOOT_HIKING|WHEELCHAIR)_MATRIX_(RES\d+)$/);
        if (!parts) return null;
        const tableRegion = parts[1];
        const region = tableRegion.replace(/_/g, ' ').replace(/\b\w/g, (c: string) => c.toUpperCase()).replace(/ /g, '');
        const profileName = parts[2].toLowerCase().replace(/_/g, '-');
        const resolution = parts[3];
        const lookupKey = `${tableRegion}_${parts[2]}_${resolution}`;
        return { region, table_region: tableRegion, profile: profileName, resolution, row_count: parseInt(t.ROW_COUNT || '0'), bytes: parseInt(t.BYTES || '0'), created: t.CREATED || '', table_name: name, execution_time_secs: 0, road_filter: roadFilterMap[lookupKey] === true };
      }).filter(Boolean);
    } catch {}
    return NextResponse.json({ inventory });
  } catch (err) {
    return NextResponse.json({ inventory: [], error: (err as Error).message });
  }
});

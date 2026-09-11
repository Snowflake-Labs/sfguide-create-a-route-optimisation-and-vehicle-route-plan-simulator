// Matrix-viewer shared helpers (ported from ors_control_app server/routes/matrix/query.ts).
// parseViewerTableName / getViewerInventory (60s cache) / validateViewerTable are
// used by the /api/matrix/* viewer route handlers.
import { SF_DATABASE } from '@/server/constants';
import { runSql } from '@/server/lib/sql';

const VIEWER_PROFILE_PATTERNS = ['DRIVING_CAR', 'DRIVING_HGV', 'CYCLING_REGULAR', 'CYCLING_ROAD', 'CYCLING_MOUNTAIN', 'CYCLING_ELECTRIC', 'FOOT_WALKING', 'FOOT_HIKING', 'WHEELCHAIR'];

export function parseViewerTableName(name: string): { region: string; profile: string; resolution: string } | null {
  for (const profile of VIEWER_PROFILE_PATTERNS) {
    const pattern = new RegExp(`^(.+?)_${profile}_MATRIX_(RES\\d+)$`);
    const match = name.match(pattern);
    if (match) {
      return { region: match[1], profile: profile.toLowerCase().replace(/_/g, '-'), resolution: match[2] };
    }
  }
  return null;
}

interface ViewerTable { region: string; profile: string; resolution: string; row_count: number; bytes: number; table_name: string; full_table: string; road_filter: boolean; }
const VIEWER_CACHE_TTL = 60000;
const cacheRef = ((globalThis as unknown as { __fleetAdminViewerCache?: { tables: ViewerTable[]; ts: number } }).__fleetAdminViewerCache ??= { tables: [], ts: 0 });

export async function getViewerInventory(): Promise<ViewerTable[]> {
  if (Date.now() - cacheRef.ts < VIEWER_CACHE_TTL && cacheRef.tables.length > 0) return cacheRef.tables;
  const rows = await runSql(`
    SELECT TABLE_NAME, ROW_COUNT, BYTES
    FROM ${SF_DATABASE}.INFORMATION_SCHEMA.TABLES
    WHERE TABLE_SCHEMA = 'TRAVEL_MATRIX'
      AND TABLE_NAME LIKE '%\\_MATRIX\\_%' ESCAPE '\\\\'
      AND TABLE_NAME NOT LIKE '%\\_MATRIX\\_RAW\\_%' ESCAPE '\\\\'
      AND TABLE_NAME NOT LIKE '%\\_LIST\\_%' ESCAPE '\\\\'
      AND TABLE_NAME NOT LIKE '%\\_WORK\\_QUEUE\\_%' ESCAPE '\\\\'
      AND TABLE_NAME != 'MATRIX_BUILD_JOBS'
    ORDER BY TABLE_NAME
  `);
  const roadFilterMap: Record<string, boolean> = {};
  try {
    const jobRows = await runSql(
      `SELECT REGION, PROFILE, RESOLUTION, ROAD_FILTER AS RF
       FROM (
         SELECT REGION, PROFILE, RESOLUTION, ROAD_FILTER,
                ROW_NUMBER() OVER (PARTITION BY REGION, PROFILE, RESOLUTION ORDER BY COMPLETED_AT DESC NULLS LAST) AS RN
         FROM ${SF_DATABASE}.TRAVEL_MATRIX.MATRIX_BUILD_JOBS
         WHERE STATUS = 'COMPLETE'
       ) WHERE RN = 1`,
    );
    for (const r of jobRows || []) {
      const key = `${(r.REGION || '').toUpperCase()}_${(r.PROFILE || '').replace(/-/g, '_').toUpperCase()}_${r.RESOLUTION}`;
      roadFilterMap[key] = r.RF === true || r.RF === 'true';
    }
  } catch {}
  const tables = rows.map((r) => {
    const parsed = parseViewerTableName(r.TABLE_NAME);
    if (!parsed) return null;
    const lookupKey = `${(parsed.region || '').toUpperCase()}_${(parsed.profile || '').replace(/-/g, '_').toUpperCase()}_${parsed.resolution}`;
    return {
      ...parsed,
      row_count: parseInt(r.ROW_COUNT || '0'),
      bytes: parseInt(r.BYTES || '0'),
      table_name: r.TABLE_NAME,
      full_table: `${SF_DATABASE}.TRAVEL_MATRIX.${r.TABLE_NAME}`,
      road_filter: roadFilterMap[lookupKey] === true,
    } as ViewerTable;
  }).filter(Boolean) as ViewerTable[];
  // Exclude matrices with no pairs. ENSURE_MATRIX_TABLES creates the table when
  // a build STARTS, so a still-running build is already listed here with
  // ROW_COUNT 0 - and selecting it made the viewer silently unviewable: the
  // random-origin probe finds no ORIGIN_H3, so nothing loads.
  //
  // Consequence accepted deliberately: a region whose only matrix is still
  // building drops out of the Region dropdown until it has rows. That is honest
  // - there is nothing to view yet - and the alternative is offering a
  // selection that cannot work.
  //
  // Note ROW_COUNT here is INFORMATION_SCHEMA metadata, which is maintained
  // lazily, and this inventory is cached for 60s. So this filter reduces the
  // failure but cannot eliminate it; the client must still handle an empty
  // result rather than assuming a listed table is loadable.
  const viewable = tables.filter((t) => t.row_count > 0);
  cacheRef.tables = viewable;
  cacheRef.ts = Date.now();
  return viewable;
}

export function validateViewerTable(tableName: string): string | null {
  const tables = cacheRef.tables;
  const found = tables.find((t) => t.full_table === tableName || t.table_name === tableName);
  if (found) return found.full_table;
  if (/^[A-Z0-9_]+\.[A-Z0-9_]+\.[A-Z0-9_]+$/i.test(tableName)) {
    const parsed = parseViewerTableName(tableName.split('.').pop()!);
    if (parsed) return tableName;
  }
  return null;
}

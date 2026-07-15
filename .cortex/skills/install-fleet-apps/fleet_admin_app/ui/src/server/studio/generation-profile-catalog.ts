// Generation profile catalog - persists the built-in generation profiles
// (formerly TypeScript-only PROFILE_TEMPLATES) as DATA in Snowflake so a new
// vehicle mode can be onboarded by INSERTing a profile row (with the declarative
// knobs the de-branched engine reads), with ZERO generator code edits.
//
// PROFILE_TEMPLATES remains the seed source of truth for the built-in rows; the
// boot MERGE upserts those (IS_BUILTIN=TRUE) and never touches user-added rows.
// The /api/studio/templates endpoint reads this table (falling back to the
// in-memory templates if the table is unavailable), so data rows become
// selectable templates.

import { PROFILE_TEMPLATES } from './profiles';

type SnowSqlFn = (sql: string, database?: string, schema?: string) => Promise<any[]>;

const TRACK = `{"origin":"sf_sit-is-fleet","name":"oss-install-fleet-apps","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}`;

const DDL = `CREATE TABLE IF NOT EXISTS FLEET_INTELLIGENCE.CORE.GENERATION_PROFILE_CATALOG (
  TEMPLATE_ID    VARCHAR PRIMARY KEY,
  NAME           VARCHAR,
  DESCRIPTION    VARCHAR,
  VEHICLE_TYPE   VARCHAR,
  ORS_PROFILE    VARCHAR,
  REGION_SCALE   VARCHAR,
  FEEDS          VARIANT,
  DEFAULT_CONFIG VARIANT,
  IS_BUILTIN     BOOLEAN DEFAULT TRUE,
  CREATED_AT     TIMESTAMP_NTZ DEFAULT SYSDATE(),
  UPDATED_AT     TIMESTAMP_NTZ DEFAULT SYSDATE()
) COMMENT = '${TRACK}'`;

function seedMergeSql(): string {
  const rows = PROFILE_TEMPLATES.map((t) => {
    const feeds = `PARSE_JSON($$${JSON.stringify(t.feeds ?? [])}$$)`;
    const cfg = `PARSE_JSON($$${JSON.stringify(t.defaultConfig ?? {})}$$)`;
    // String fields are template-controlled (no apostrophes), safe to inline.
    return `SELECT '${t.id}' AS TEMPLATE_ID, '${t.name.replace(/'/g, "''")}' AS NAME, ` +
      `'${(t.description || '').replace(/'/g, "''")}' AS DESCRIPTION, '${t.vehicleType}' AS VEHICLE_TYPE, ` +
      `'${t.orsProfile}' AS ORS_PROFILE, '${t.regionScale}' AS REGION_SCALE, ${feeds} AS FEEDS, ${cfg} AS DEFAULT_CONFIG`;
  }).join('\n      UNION ALL ');
  // Refresh built-in rows on every boot (so re-tuned defaults propagate); never
  // touch user-added rows (IS_BUILTIN = FALSE).
  return `MERGE INTO FLEET_INTELLIGENCE.CORE.GENERATION_PROFILE_CATALOG tgt
    USING (
      ${rows}
    ) src
    ON tgt.TEMPLATE_ID = src.TEMPLATE_ID
    WHEN MATCHED AND tgt.IS_BUILTIN = TRUE THEN UPDATE SET
      NAME = src.NAME, DESCRIPTION = src.DESCRIPTION, VEHICLE_TYPE = src.VEHICLE_TYPE,
      ORS_PROFILE = src.ORS_PROFILE, REGION_SCALE = src.REGION_SCALE, FEEDS = src.FEEDS,
      DEFAULT_CONFIG = src.DEFAULT_CONFIG, UPDATED_AT = SYSDATE()
    WHEN NOT MATCHED THEN INSERT (TEMPLATE_ID, NAME, DESCRIPTION, VEHICLE_TYPE, ORS_PROFILE, REGION_SCALE, FEEDS, DEFAULT_CONFIG, IS_BUILTIN)
      VALUES (src.TEMPLATE_ID, src.NAME, src.DESCRIPTION, src.VEHICLE_TYPE, src.ORS_PROFILE, src.REGION_SCALE, src.FEEDS, src.DEFAULT_CONFIG, TRUE)`;
}

// One-time cleanup of the legacy built-in template ids (renamed to the neutral
// vehicle-class scheme: urban-car / urban-ebike / regional-hgv). On existing
// accounts these stale rows would otherwise linger forever (the MERGE only
// upserts the new ids and never deletes). User-added rows are never touched.
const STALE_BUILTIN_CLEANUP = `DELETE FROM FLEET_INTELLIGENCE.CORE.GENERATION_PROFILE_CATALOG
  WHERE IS_BUILTIN = TRUE
    AND TEMPLATE_ID IN ('city-taxis', 'ebike-couriers', 'hgv-logistics')`;

// Idempotent: CREATE TABLE IF NOT EXISTS + stale-builtin cleanup + MERGE upsert
// of the built-in rows. Safe to call on every boot.
export async function ensureGenerationProfileCatalog(snowSql: SnowSqlFn): Promise<void> {
  await snowSql(DDL, 'FLEET_INTELLIGENCE', 'CORE');
  await snowSql(STALE_BUILTIN_CLEANUP, 'FLEET_INTELLIGENCE', 'CORE');
  await snowSql(seedMergeSql(), 'FLEET_INTELLIGENCE', 'CORE');
}

export interface GenerationProfileRow {
  id: string;
  name: string;
  description: string;
  vehicleType: string;
  orsProfile: string;
  regionScale: string;
  feeds: string[];
  defaultConfig: Record<string, any>;
}

// Read all profiles (built-in + user-added) for the /templates endpoint. Returns
// null on failure so the caller can fall back to the in-memory PROFILE_TEMPLATES.
export async function listGenerationProfiles(snowSql: SnowSqlFn): Promise<GenerationProfileRow[] | null> {
  try {
    const rows = await snowSql(
      `SELECT TEMPLATE_ID, NAME, DESCRIPTION, VEHICLE_TYPE, ORS_PROFILE, REGION_SCALE, FEEDS, DEFAULT_CONFIG
       FROM FLEET_INTELLIGENCE.CORE.GENERATION_PROFILE_CATALOG
       ORDER BY IS_BUILTIN DESC, TEMPLATE_ID`,
      'FLEET_INTELLIGENCE', 'CORE',
    );
    if (!rows || rows.length === 0) return null;
    return rows.map((r: any) => ({
      id: r.TEMPLATE_ID,
      name: r.NAME,
      description: r.DESCRIPTION,
      vehicleType: r.VEHICLE_TYPE,
      orsProfile: r.ORS_PROFILE,
      regionScale: r.REGION_SCALE,
      feeds: typeof r.FEEDS === 'string' ? JSON.parse(r.FEEDS) : (r.FEEDS ?? []),
      defaultConfig: typeof r.DEFAULT_CONFIG === 'string' ? JSON.parse(r.DEFAULT_CONFIG) : (r.DEFAULT_CONFIG ?? {}),
    }));
  } catch {
    return null;
  }
}

const rawDb = process.env.SNOWFLAKE_DATABASE || '';
export const SF_DATABASE = (rawDb && !rawDb.includes('{{')) ? rawDb : 'OPENROUTESERVICE_APP';

// TWO warehouses, split by WORKLOAD rather than by app (see
// scripts/warehouses.sql for the full rationale):
//
//   SF_WAREHOUSE       - FLEET_APPS_WH. Interactive reads (the sync `runSql`
//                        transport). Must never queue behind batch work.
//   SF_BATCH_WAREHOUSE - ROUTING_ANALYTICS. Long-running submissions (the
//                        async `submitSqlAsync` transport): region provisioning
//                        and matrix builds.
//
// Repointing the whole app at one new warehouse would NOT have fixed anything.
// `PROVISION_REGION_WRAPPER` runs as THIS app (user FLEET_ADMIN_APP), as a
// single statement, for up to 23,600 seconds, and its poll loop issues
// `SELECT SYSTEM$WAIT(30)` hundreds of times -- each one occupying a
// concurrency slot purely to sleep. Moving that onto the app warehouse would
// have starved interactive reads exactly as before. The split works because
// `submitSqlAsync` already IS the long-running path (it submits with
// `timeout: 0`), so routing by transport routes by workload.
//
// The fallbacks are the real warehouse names, not a generic one. An env var
// that fails to interpolate must not silently degrade to a warehouse this stack
// never creates and never grants: the SA app shipped `|| 'COMPUTE_WH'` in three
// files, and on an account without COMPUTE_WH (or without a grant on it) that
// meant every query failed at runtime while the service reported healthy.
export const DEFAULT_WAREHOUSE = 'FLEET_APPS_WH';
export const DEFAULT_BATCH_WAREHOUSE = 'ROUTING_ANALYTICS';

const rawWh = process.env.SNOWFLAKE_WAREHOUSE || '';
export let SF_WAREHOUSE = (rawWh && !rawWh.includes('{{')) ? rawWh : DEFAULT_WAREHOUSE;
export function setWarehouse(name: string): void { SF_WAREHOUSE = name; }

const rawBatchWh = process.env.SNOWFLAKE_BATCH_WAREHOUSE || '';
export const SF_BATCH_WAREHOUSE = (rawBatchWh && !rawBatchWh.includes('{{'))
  ? rawBatchWh
  : DEFAULT_BATCH_WAREHOUSE;

export const SNOWFLAKE_HOST = process.env.SNOWFLAKE_HOST || '';
export const IS_SPCS = !!SNOWFLAKE_HOST;
export const CONN = process.env.SNOWFLAKE_CONNECTION || '';

// NOTE: the session query_tag lives in server/lib/sql.ts as QUERY_TAG_VALUE, which
// is the single writer for every Snowflake call this app makes. A duplicate
// QUERY_TAG was exported here, unreferenced, still carrying the pre-AGENTS.md
// `"version":"1.0"` shape - a trap for the next caller. Do not reintroduce it.

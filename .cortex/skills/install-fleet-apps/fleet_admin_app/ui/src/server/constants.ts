const rawDb = process.env.SNOWFLAKE_DATABASE || '';
export const SF_DATABASE = (rawDb && !rawDb.includes('{{')) ? rawDb : 'OPENROUTESERVICE_APP';

export let SF_WAREHOUSE = process.env.SNOWFLAKE_WAREHOUSE || '';
export function setWarehouse(name: string): void { SF_WAREHOUSE = name; }

export const SNOWFLAKE_HOST = process.env.SNOWFLAKE_HOST || '';
export const IS_SPCS = !!SNOWFLAKE_HOST;
export const CONN = process.env.SNOWFLAKE_CONNECTION || '';

export const DEFAULT_WAREHOUSE = 'ROUTING_ANALYTICS';
// NOTE: the session query_tag lives in server/lib/sql.ts as QUERY_TAG_VALUE, which
// is the single writer for every Snowflake call this app makes. A duplicate
// QUERY_TAG was exported here, unreferenced, still carrying the pre-AGENTS.md
// `"version":"1.0"` shape - a trap for the next caller. Do not reintroduce it.

import { existsSync } from 'fs';
export const IS_SPCS = existsSync('/snowflake/session/token');
const rawDb = process.env.SNOWFLAKE_DATABASE || '';
export const SF_DATABASE = (rawDb && !rawDb.includes('{{')) ? rawDb : 'OPENROUTESERVICE_NATIVE_APP';
export let SF_WAREHOUSE = process.env.SNOWFLAKE_WAREHOUSE || '';
export function setWarehouse(name) { SF_WAREHOUSE = name; }
export const CONN = process.env.SNOWFLAKE_CONNECTION_NAME || 'FREE_TRIAL';
export const SNOWFLAKE_HOST = process.env.SNOWFLAKE_HOST || '';
export const DEFAULT_WAREHOUSE = 'ROUTING_ANALYTICS';
export const QUERY_TAG = '{"origin":"sf_sit-is-fleet","name":"ors-control-app","version":"1.0"}';

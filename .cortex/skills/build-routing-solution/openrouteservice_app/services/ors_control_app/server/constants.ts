const rawDb = process.env.SNOWFLAKE_DATABASE || '';
export const SF_DATABASE = (rawDb && !rawDb.includes('{{')) ? rawDb : 'OPENROUTESERVICE_APP';

export let SF_WAREHOUSE = process.env.SNOWFLAKE_WAREHOUSE || '';
export function setWarehouse(name: string): void { SF_WAREHOUSE = name; }

export const SNOWFLAKE_HOST = process.env.SNOWFLAKE_HOST || '';
export const IS_SPCS = !!SNOWFLAKE_HOST;
export const CONN = process.env.SNOWFLAKE_CONNECTION || '';

export const DEFAULT_WAREHOUSE = 'ROUTING_ANALYTICS';
export const QUERY_TAG = '{"origin":"sf_sit-is-fleet","name":"ors-control-app","version":"1.0"}';

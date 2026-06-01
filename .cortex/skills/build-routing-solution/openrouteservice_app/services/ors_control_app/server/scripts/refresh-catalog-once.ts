// One-off CLI: scrape Geofabrik/BBBike and repopulate REGION_CATALOG via snow sql.
// Usage: SNOWFLAKE_CONNECTION=fleet_test_evals npx tsx server/scripts/refresh-catalog-once.ts

import { config } from 'dotenv';
import { runSql } from '../lib/sql.js';
import { refreshRegionCatalog } from '../lib/refresh-region-catalog.js';

config();

const result = await refreshRegionCatalog(runSql);
console.log(JSON.stringify({ status: 'ok', result }, null, 2));

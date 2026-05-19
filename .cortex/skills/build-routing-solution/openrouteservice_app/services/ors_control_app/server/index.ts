import express from 'express';
import cors from 'cors';
import { config } from 'dotenv';
import { existsSync } from 'fs';
import { join } from 'path';
import { createStudioRouter } from './studio/routes.js';
import { reconcileStaleJobs, setRegionActivatedHandler } from './studio/jobs.js';
import { log, getEntries, clearEntries, getUptimeMs } from './diagnostics.js';
import { IS_SPCS, SF_DATABASE, SF_WAREHOUSE, setWarehouse, CONN, SNOWFLAKE_HOST, DEFAULT_WAREHOUSE } from './constants.js';
import { safeRegionIdent, orsServiceName, orsServiceFqn, isDefaultRegion, currentRegionScalar, DEFAULT_REGION_NAME } from './lib/region.js';
import { sanitizeIdentifier, sanitizeFloat, sanitizeInt, escapeString, getSpcsToken, toIso } from './lib/sanitize.js';
import { snowSqlLocal, snowSqlSpcs, runSql, callProcedure, submitSqlAsync, cancelStatement } from './lib/sql.js';
import { detectWarehouse } from './lib/warehouse.js';
import { waitForOrsGraphReady, getExpectedProfiles, DEFAULT_PROFILES } from './lib/ors.js';
import { roadPointsCacheKey, roadPointsCacheGet, roadPointsCacheSet, formatUptime } from './lib/cache.js';
import { ensureBackloadAndAssetVelocityObjects } from './lib/init.js';
import { createStatusRouter } from './routes/status.js';
import { createServicesRouter } from './routes/services.js';
import { createDiagnosticsRouter } from './routes/diagnostics.js';
import { createSamplingRouter } from './routes/sampling.js';
import { createFleetRouter } from './routes/fleet.js';
import { createMatrixRouter } from './routes/matrix.js';
import { createAgentRouter } from './routes/agent.js';
import { createRegionsRouter } from './routes/regions/index.js';
import { createQueryRouter } from './routes/query.js';
import { createStaticRouter } from './routes/static.js';
import { getActiveRegionOverride, setActiveRegionOverride } from './lib/state.js';

config();

const app = express();
app.use(cors());
app.use(express.json({ limit: '10mb' }));






const APP_VERSION = process.env.APP_VERSION || '0.0.0';

app.use(createStatusRouter(APP_VERSION));
app.use(createServicesRouter());
app.use(createDiagnosticsRouter(APP_VERSION));
app.use(createSamplingRouter());
app.use(createFleetRouter());
app.use(createRegionsRouter());
app.use(createMatrixRouter());
app.use(createAgentRouter());

app.use('/api/studio', createStudioRouter(runSql));

app.use(createQueryRouter());

const distDir = join(import.meta.dirname || '.', '../dist');

app.use(createStaticRouter(distDir));

async function verifySessionUtc(): Promise<void> {
  try {
    const rows = await runSql(`SELECT TO_VARCHAR(CURRENT_TIMESTAMP(),'YYYY-MM-DD"T"HH24:MI:SS.FF3TZH:TZM') AS NOW_LTZ, TO_VARCHAR(SYSDATE(),'YYYY-MM-DD"T"HH24:MI:SS.FF3') AS NOW_UTC`);
    const nowLtz: string = rows?.[0]?.NOW_LTZ || '';
    const nowUtc: string = rows?.[0]?.NOW_UTC || '';
    const ok = /\+00:?00$/.test(nowLtz) || /Z$/.test(nowLtz);
    if (!ok) {
      console.error(`[FATAL] Session TZ guard failed. CURRENT_TIMESTAMP=${nowLtz} (expected +00:00). SYSDATE=${nowUtc}.`);
      process.exit(1);
    }
    console.log(`[TZ guard] Session is UTC. CURRENT_TIMESTAMP=${nowLtz} SYSDATE=${nowUtc}`);
  } catch (err: any) {
    console.error(`[FATAL] Session TZ guard query failed: ${err.message?.slice(0, 300)}`);
    process.exit(1);
  }
}

const PORT = parseInt(process.env.PORT || '3001');
detectWarehouse().then(verifySessionUtc).then(() => {
  app.listen(PORT, '0.0.0.0', () => {
    console.log(`ORS Control App server running on port ${PORT} (SPCS: ${IS_SPCS}, WH: ${SF_WAREHOUSE})`);
  });
  reconcileStaleJobs(runSql, 30).catch((e) => {
    log('WARN', 'Studio', `Boot reconcile failed: ${e?.message?.slice(0, 200)}`);
  });

  // Hydrate getActiveRegionOverride() from REGION_REGISTRY so the user's last
  // region selection survives SPCS container restarts. POST /api/regions/active
  // already persists the choice to REGION_REGISTRY.IS_DEFAULT (via the
  // SET_ACTIVE_REGION procedure), but the in-memory override resets to null
  // on every container boot. Read it back here so the next /api/regions call
  // returns the persisted active region instead of falling back to the seeded
  // SanFrancisco default.
  (async () => {
    try {
      const rows = await runSql(
        `SELECT REGION_NAME FROM FLEET_INTELLIGENCE.CORE.REGION_REGISTRY WHERE IS_DEFAULT = TRUE LIMIT 1`,
        'FLEET_INTELLIGENCE', 'CORE',
      );
      const persisted = rows?.[0]?.REGION_NAME;
      if (persisted) {
        setActiveRegionOverride(persisted);
        log('INFO', 'Region', `Hydrated getActiveRegionOverride() from REGION_REGISTRY: ${persisted}`);
      }
    } catch (e: any) {
      log('WARN', 'Region', `getActiveRegionOverride() hydrate failed: ${e?.message?.slice(0, 150)}`);
    }
  })();

  // Wire Data Studio completion -> immediately refresh in-memory override so
  // the freshly generated region appears as active without waiting for the
  // user to click the switcher (or for a container restart to re-hydrate).
  setRegionActivatedHandler((region: string) => {
    if (!region) return;
    setActiveRegionOverride(region);
    log('INFO', 'Region', `Active region updated by Data Studio: ${region}`);
  });

  // Boot-time idempotent init: ensure Backload Matching schema/views and
  // Asset Velocity views exist on every container start. This makes both demos
  // work out-of-the-box on a fresh install without requiring a manual
  // `snow sql -f bootstrap.sql` step.
  (async () => {
    try {
      await ensureBackloadAndAssetVelocityObjects(runSql);
      log('INFO', 'Init', 'Backload Matching + Asset Velocity objects ensured');
    } catch (e: any) {
      log('WARN', 'Init', `Boot init failed: ${e?.message?.slice(0, 200)}`);
    }
  })();
});
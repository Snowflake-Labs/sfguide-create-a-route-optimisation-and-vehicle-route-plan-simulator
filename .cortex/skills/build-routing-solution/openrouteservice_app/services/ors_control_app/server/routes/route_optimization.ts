// /api/route-optimization/ensure-seeded — region-agnostic self-heal.
//
// The Route Optimisation page calls this on every region change. It probes
// FLEET_INTELLIGENCE.ROUTE_OPTIMIZATION.LOOKUP for the supplied region; if the
// region has zero rows, it synchronously runs SEED_ROUTE_OPTIMIZATION_REGION
// so the page never sees an empty Industry dropdown again.
//
// PROVISION_REGION_WRAPPER already calls the same proc when a region is
// provisioned, but that path has historically swallowed exceptions silently
// (now logged to REGION_PROVISION_JOBS.MESSAGE). This endpoint guarantees
// recovery for any region the user opens regardless of how/when it was
// provisioned.
//
// In-flight requests are deduplicated per-region via a process-local map so
// double-clicks / parallel tabs don't double-seed.

import { Router } from 'express';
import { runSql } from '../lib/sql.js';
import { escapeString } from '../lib/sanitize.js';
import { ensureAssetVelocityViews } from '../lib/init.js';
import { log } from '../diagnostics.js';

interface SeedResult {
  region: string;
  seeded: boolean;
  message?: string;
  error?: string;
}

// Per-region in-flight dedupe so concurrent calls share one underlying CALL.
const inflight = new Map<string, Promise<SeedResult>>();

async function ensureSeededOnce(region: string): Promise<SeedResult> {
  const safe = escapeString(region);
  // Cheap check first — if LOOKUP already populated, nothing to do.
  const lookupRows = await runSql(
    `SELECT COUNT(*) AS N FROM FLEET_INTELLIGENCE.ROUTE_OPTIMIZATION.LOOKUP WHERE REGION = '${safe}'`
  );
  const n = Number(lookupRows?.[0]?.N ?? 0);
  if (n > 0) {
    return { region, seeded: false, message: `lookup already populated (${n} industries)` };
  }
  log('INFO', 'RouteOpt', `ensure-seeded: seeding region '${region}' (LOOKUP empty)`);
  try {
    const seedRows = await runSql(
      `CALL FLEET_INTELLIGENCE.ROUTE_OPTIMIZATION.SEED_ROUTE_OPTIMIZATION_REGION('${safe}')`,
      'FLEET_INTELLIGENCE',
      'ROUTE_OPTIMIZATION'
    );
    const msg = seedRows?.[0]?.SEED_ROUTE_OPTIMIZATION_REGION ?? 'seeded';
    log('INFO', 'RouteOpt', `ensure-seeded: ${region} -> ${String(msg).slice(0, 200)}`);
    return { region, seeded: true, message: String(msg) };
  } catch (err: any) {
    log('ERROR', 'RouteOpt', `ensure-seeded: ${region} -> ${err.message?.slice(0, 300)}`);
    return { region, seeded: false, error: err.message };
  }
}

export function createRouteOptimizationRouter(): Router {
  const router = Router();

  router.post('/api/route-optimization/ensure-seeded', async (req, res) => {
    const region = String(req.body?.region || '').trim();
    if (!region) return res.status(400).json({ error: 'region required' });

    let p = inflight.get(region);
    if (!p) {
      p = ensureSeededOnce(region).finally(() => {
        // Clear after completion so a future failure can be retried.
        inflight.delete(region);
      });
      inflight.set(region, p);
    }
    const result = await p;
    if (result.error) return res.status(500).json(result);
    res.json(result);
  });

  // /api/asset-velocity/ensure — lazy self-heal for the Asset Velocity page.
  // The four ROUTE_OPTIMIZATION views reference DWELL_ANALYSIS.DT_DWELL_ENRICHED,
  // which Snowflake validates at CREATE VIEW time, so on a fresh install where
  // dwell-analysis is deployed AFTER the container booted, the boot-time create
  // fails silently. The Asset Velocity page calls this on mount; the first call
  // after dwell exists (re)creates the views with no container restart needed.
  // Idempotent + de-duped; never 500s the page (returns { ensured:false } with a
  // reason when dwell is not yet deployed).
  let avInflight: Promise<{ ensured: boolean; reason?: string }> | null = null;
  router.post('/api/asset-velocity/ensure', async (_req, res) => {
    if (!avInflight) {
      avInflight = ensureAssetVelocityViews(runSql).finally(() => {
        avInflight = null;
      });
    }
    try {
      const result = await avInflight;
      res.json(result);
    } catch (err: any) {
      // ensureAssetVelocityViews is log-only and should not throw, but guard
      // anyway so the page never receives a 500.
      log('ERROR', 'AssetVelocity', `ensure failed: ${err?.message?.slice(0, 300)}`);
      res.json({ ensured: false, reason: 'ensure-failed' });
    }
  });

  return router;
}

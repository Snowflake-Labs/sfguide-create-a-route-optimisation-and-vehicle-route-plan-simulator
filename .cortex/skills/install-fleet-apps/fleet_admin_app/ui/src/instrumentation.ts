// Next.js instrumentation hook - runs ONCE at server process startup
// (replaces the Express boot-init in the legacy Vite control app).
//
// R5 decision "new app also runs init": this app runs the same idempotent
// init.ts as the FLEET_SA_APP. All statements are CREATE OR REPLACE /
// IF NOT EXISTS, so concurrent boots converge with no diff. Guarded by a
// globalThis once-flag so it never runs twice in a single process (Next dev HMR
// or multiple route-module loads).

export async function register(): Promise<void> {
  // Only run in the Node.js server runtime (not edge / browser).
  if (process.env.NEXT_RUNTIME !== 'nodejs') return;

  const g = globalThis as unknown as { __fleetAdminBootInit?: Promise<void> };
  if (g.__fleetAdminBootInit) return g.__fleetAdminBootInit;

  g.__fleetAdminBootInit = (async () => {
    const { runSql } = await import('@/server/lib/sql');
    const { ensureBackloadAndAssetVelocityObjects, ensureObservabilityObjects } =
      await import('@/server/lib/init');
    const { log } = await import('@/server/diagnostics');

    const t0 = Date.now();
    try {
      // Shared SQL substrate: UNIFIED base tables + DIM_DATASETS, V_*_CURRENT
      // dataset-versioning views, scoped-contract UDTFs, backload/marketplace
      // projection views, asset-velocity views.
      await ensureBackloadAndAssetVelocityObjects(runSql);
    } catch (err) {
      log('ERROR', 'BootInit', `ensureBackloadAndAssetVelocityObjects failed: ${
        (err as Error)?.message?.slice(0, 300)
      }`);
    }
    try {
      // Observability schema + ORS_REQUEST_LOG + V_ORS_METRICS_SUMMARY - needed
      // by the Observability admin page.
      await ensureObservabilityObjects(runSql);
    } catch (err) {
      log('ERROR', 'BootInit', `ensureObservabilityObjects failed: ${
        (err as Error)?.message?.slice(0, 300)
      }`);
    }

    // Mark any orphaned RUNNING jobs as FAILED (container crash / restart recovery).
    // Also reconcile auto_suspend_secs on services that were pinned to 0 for a
    // generation run that never completed its scaleDown().
    try {
      const { reconcileStaleJobs } = await import('@/server/studio/jobs');
      const reconciled = await reconcileStaleJobs(runSql, 30);
      if (reconciled > 0) {
        log('WARN', 'BootInit', `Reconciled ${reconciled} orphaned studio job(s)`);
        try {
          await runSql(`CALL OPENROUTESERVICE_APP.CORE.RECONCILE_AUTO_SUSPEND()`);
        } catch (reconcileErr) {
          log('WARN', 'BootInit', `RECONCILE_AUTO_SUSPEND failed: ${
            (reconcileErr as Error)?.message?.slice(0, 200)
          }`);
        }
      }
    } catch (err) {
      log('WARN', 'BootInit', `Studio job reconcile failed: ${
        (err as Error)?.message?.slice(0, 200)
      }`);
    }

    log('INFO', 'BootInit', `boot init complete in ${Date.now() - t0}ms`);
  })();

  return g.__fleetAdminBootInit;
}

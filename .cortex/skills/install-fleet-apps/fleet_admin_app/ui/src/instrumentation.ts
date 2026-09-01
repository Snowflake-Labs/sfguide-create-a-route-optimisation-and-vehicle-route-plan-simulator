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

    // Cost: the accelerator's data is synthetic / rebuildable, so Time Travel
    // (and the 7-day Fail-safe that rides on non-zero retention) is pure storage
    // cost. Converge every accelerator database to DATA_RETENTION_TIME_IN_DAYS=0
    // at boot so an ALREADY-DEPLOYED account (created before this change) is
    // fixed on the next restart, not just fresh installs. Best-effort + IF
    // EXISTS: a missing DB or permission gap never blocks boot.
    try {
      for (const db of ['FLEET_INTELLIGENCE', 'SYNTHETIC_DATASETS', 'OPENROUTESERVICE_APP', 'FLEET_APP', 'ROUTING_PLATFORM']) {
        try {
          await runSql(`ALTER DATABASE IF EXISTS ${db} SET DATA_RETENTION_TIME_IN_DAYS = 0`);
        } catch { /* per-db best-effort */ }
      }
    } catch (err) {
      log('WARN', 'BootInit', `retention convergence failed: ${
        (err as Error)?.message?.slice(0, 200)
      }`);
    }

    // Cost: converge the core routing pool + gateway to their right-sized shape
    // on already-deployed accounts (fresh installs get this from
    // 01_core_infra.sql). Pool MIN_NODES 5 -> 1 (holds a single idle highmem
    // node, scales to 5 under load); gateway MIN_INSTANCES 3 -> 1 (scales to 3).
    // The gateway's 1h idle window is converged separately by RECONCILE_AUTO_SUSPEND.
    // Best-effort: never blocks boot.
    try {
      await runSql(`ALTER COMPUTE POOL IF EXISTS OPENROUTESERVICE_APP_COMPUTE_POOL SET MIN_NODES = 1 MAX_NODES = 5`);
    } catch { /* pool may be mid-operation */ }
    try {
      await runSql(`ALTER SERVICE IF EXISTS OPENROUTESERVICE_APP.CORE.routing_gateway_service SET MIN_INSTANCES = 1 MAX_INSTANCES = 3`);
    } catch { /* service may be suspended/updating */ }

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
      // null = no age filter: at boot the in-memory job map is always empty,
      // so every RUNNING row is provably orphaned regardless of age.
      const reconciled = await reconcileStaleJobs(runSql, null);
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

    // Periodic reconciler: catches jobs whose worker dies while the container
    // stays up (the boot reconcile only covers restarts, and the in-process
    // watchdog dies with the worker). Uses HEARTBEAT_AT with a 20-min window,
    // comfortably longer than the 60 s flush interval. MAX_INSTANCES = 1 today
    // so the in-memory exclusion is per-process correct; a future scale-out
    // would need cross-instance coordination.
    const RECONCILE_INTERVAL_MS = 5 * 60_000;
    setInterval(async () => {
      try {
        const { reconcileStaleJobs } = await import('@/server/studio/jobs');
        const n = await reconcileStaleJobs(runSql, 20);
        if (n > 0) {
          log('WARN', 'PeriodicReconcile', `Reconciled ${n} stale studio job(s)`);
          try {
            await runSql(`CALL OPENROUTESERVICE_APP.CORE.RECONCILE_AUTO_SUSPEND()`);
          } catch { /* best-effort */ }
        }
      } catch { /* never crash the interval */ }
    }, RECONCILE_INTERVAL_MS);

    log('INFO', 'BootInit', `boot init complete in ${Date.now() - t0}ms`);
  })();

  return g.__fleetAdminBootInit;
}

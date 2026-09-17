-- =============================================================================
-- install-fleet-apps : canonical warehouse definitions (SINGLE OWNER)
-- =============================================================================
-- This file is the ONE authoritative definition of the two warehouses this
-- stack owns. Every other site that ensures a warehouse exists must match the
-- specs below byte-for-byte; `scripts/check_warehouse_ddl.py` (pre-commit)
-- enforces that, because the drift it prevents was silent and expensive.
--
-- WHY THIS FILE EXISTS
-- Seven different files used to run `CREATE WAREHOUSE IF NOT EXISTS
-- ROUTING_ANALYTICS`, with THREE different specs between them: no size at all
-- (provision_engine.sh), `AUTO_SUSPEND = 600` (the three app/bundle deploy
-- scripts) and `AUTO_SUSPEND = 60` (the three .sql layers). Because
-- `IF NOT EXISTS` makes every later statement a silent no-op, the spec an
-- account ended up with was decided by whichever step happened to run first.
-- Nothing failed, nothing warned, and the resulting spec was not reproducible
-- across installs.
--
-- WHY THERE ARE TWO WAREHOUSES
-- The apps' interactive reads and the engine's multi-hour batch work used to
-- share ONE X-Small, single-cluster warehouse whose MAX_CONCURRENCY_LEVEL is 8.
-- Measured on a real account: `PROVISION_REGION_WRAPPER` runs as the admin app
-- itself (user FLEET_ADMIN_APP) as a SINGLE statement, for up to 23,600
-- seconds, and its poll loop issues `SELECT SYSTEM$WAIT(30)` hundreds of times
-- -- 375 of them in one 8-hour window, which is 188 minutes of concurrency
-- slots spent doing nothing but sleeping. With the warehouse observed at
-- 8 running / 17 queued, ordinary dashboard reads queued past their client
-- timeout, and because the API routes turned any failure into an empty array,
-- Data Studio rendered "Total Points 0" and the SA app rendered no region or
-- date picker at all. The data was intact the whole time.
--
-- So the split is by WORKLOAD, not by app:
--   FLEET_APPS_WH     - interactive reads from BOTH apps (the sync `runSql`
--                       transport). Must never queue behind batch work.
--   ROUTING_ANALYTICS - region provisioning, matrix builds, dynamic-table
--                       refreshes, the reconciler, and the seed/analytic
--                       layers (the async `submitSqlAsync` transport).
--
-- Repointing the whole admin app at FLEET_APPS_WH would NOT have worked: it
-- would have moved the 6.5-hour provisioning statement onto the new warehouse
-- and starved it in exactly the same way. The seam that makes this correct is
-- that `submitSqlAsync` already IS the long-running path (it submits with
-- `timeout: 0`), so routing by transport routes by workload.
--
-- Idempotent, and CONVERGENT: the `ALTER WAREHOUSE ... SET` after each create
-- is deliberate. `CREATE ... IF NOT EXISTS` alone cannot correct a warehouse
-- that an earlier install already created with the wrong spec, so a reinstall
-- over a drifted account would silently keep the drift.
-- =============================================================================

ALTER SESSION SET query_tag = '{"origin":"sf_sit-is-fleet","name":"oss-install-fleet-apps","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql","module":"warehouses"}}';

-- ---------------------------------------------------------------------------
-- 1. ROUTING_ANALYTICS - batch / engine warehouse.
--    MAX_CLUSTER_COUNT = 3. This was 1 while the warehouse carried only
--    serialised region builds, where scaling out would have multiplied a build's
--    credit burn without speeding it up. That is no longer the shape of the
--    workload: Data Studio generation now runs here too, and it is deliberately
--    CONCURRENT - `parallelismForArea` returns 8/10/12 by region area (and a
--    preset can raise it with no upper bound), plus 8 more concurrent calls in
--    the offer-route precompute and two 60s timers per job. That is 13-15
--    concurrent statements against an X-Small's MAX_CONCURRENCY_LEVEL of 8, so a
--    single cluster made generation queue against ITSELF, and queue behind any
--    region build in flight. Clusters spin down when idle, so the cost is the
--    burst rather than a standing charge.
--    STATEMENT_TIMEOUT is deliberately left at the account default, because a
--    continental region build legitimately runs for hours.
-- ---------------------------------------------------------------------------
CREATE WAREHOUSE IF NOT EXISTS ROUTING_ANALYTICS
  WAREHOUSE_SIZE = 'XSMALL'
  AUTO_SUSPEND = 60
  AUTO_RESUME = TRUE
  INITIALLY_SUSPENDED = TRUE
  MIN_CLUSTER_COUNT = 1
  MAX_CLUSTER_COUNT = 3
  COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-install-fleet-apps","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql","component":"batch"}}';

ALTER WAREHOUSE ROUTING_ANALYTICS SET
  WAREHOUSE_SIZE = 'XSMALL'
  AUTO_SUSPEND = 60
  AUTO_RESUME = TRUE
  MIN_CLUSTER_COUNT = 1
  MAX_CLUSTER_COUNT = 3;

-- ---------------------------------------------------------------------------
-- 2. FLEET_APPS_WH - interactive warehouse for both apps' dashboard reads.
--    STATEMENT_TIMEOUT_IN_SECONDS = 900 is a backstop, not a target: nothing
--    on a dashboard should approach it. It is set generously because several
--    SA app views call ORS live at interaction time (Tenet 9) -- ISOCHRONES,
--    MATRIX and the Huff allocation are legitimately slow on a cold service,
--    and a tight warehouse-level timeout would break those features rather
--    than protect them. The short bound that actually matters for a stalled
--    tile lives app-side, per request.
-- ---------------------------------------------------------------------------
CREATE WAREHOUSE IF NOT EXISTS FLEET_APPS_WH
  WAREHOUSE_SIZE = 'XSMALL'
  AUTO_SUSPEND = 60
  AUTO_RESUME = TRUE
  INITIALLY_SUSPENDED = TRUE
  MIN_CLUSTER_COUNT = 1
  MAX_CLUSTER_COUNT = 1
  STATEMENT_TIMEOUT_IN_SECONDS = 900
  COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-install-fleet-apps","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql","component":"apps"}}';

ALTER WAREHOUSE FLEET_APPS_WH SET
  WAREHOUSE_SIZE = 'XSMALL'
  AUTO_SUSPEND = 60
  AUTO_RESUME = TRUE
  MIN_CLUSTER_COUNT = 1
  MAX_CLUSTER_COUNT = 1
  STATEMENT_TIMEOUT_IN_SECONDS = 900;

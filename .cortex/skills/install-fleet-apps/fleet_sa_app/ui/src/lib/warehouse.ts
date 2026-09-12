// Single owner of the SA app's warehouse resolution.
//
// All three call sites (lib/snowflake.ts, /api/query, /api/write) used to write
// `process.env.SNOWFLAKE_WAREHOUSE || 'COMPUTE_WH'` inline. COMPUTE_WH is a
// warehouse this stack does NOT create, does not grant to the app roles, and
// does not control the size of -- on a real account it happened to exist as a
// LARGE warehouse left over from something else, and on a fresh account it may
// not exist at all. Either way the failure is invisible: the service deploys,
// reports healthy, and then every query fails or silently bills a Large
// warehouse. A fallback must point at a warehouse we own.
//
// FLEET_APPS_WH is the interactive warehouse from scripts/warehouses.sql. The SA
// app issues only consumer reads, so it never needs the batch warehouse that
// carries region provisioning and matrix builds.
export const DEFAULT_WAREHOUSE = 'FLEET_APPS_WH';

const raw = process.env.SNOWFLAKE_WAREHOUSE || '';

// Guard against an uninterpolated template placeholder as well as an unset var:
// a spec that ships `{{warehouse}}` verbatim would otherwise be used as a
// warehouse name and fail on every statement.
export const WAREHOUSE = (raw && !raw.includes('{{')) ? raw : DEFAULT_WAREHOUSE;

// BATCH warehouse. Solver verbs (backload_solve, backload_chain_solve, evac_seed,
// evac_solve, optimize_routes, delivery_optimization, network_optimization) and
// /api/backload/solve run a full VRP inside a stored procedure. Every one of them
// is issued SYNCHRONOUSLY, so each occupies a warehouse slot for the whole solve.
// On an X-Small (MAX_CONCURRENCY_LEVEL 8) a handful of concurrent solves starved
// the dashboard reads sharing the interactive warehouse - the same failure mode
// /api/pack-status already recorded at 112,691 ms. Solves belong on the batch
// warehouse; read-only verbs stay interactive.
//
// FLEET_APP_USER already holds USAGE on ROUTING_ANALYTICS, so no new grant.
export const DEFAULT_BATCH_WAREHOUSE = 'ROUTING_ANALYTICS';

const rawBatch = process.env.SNOWFLAKE_BATCH_WAREHOUSE || '';

export const BATCH_WAREHOUSE = (rawBatch && !rawBatch.includes('{{'))
  ? rawBatch
  : DEFAULT_BATCH_WAREHOUSE;

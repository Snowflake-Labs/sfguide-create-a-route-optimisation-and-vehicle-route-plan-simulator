// Warehouse resolution. `constants.SF_WAREHOUSE` is resolved at module load and
// now ALWAYS has a value: the service spec's SNOWFLAKE_WAREHOUSE if present,
// otherwise the declared default (FLEET_APPS_WH). So this function is a no-op in
// practice and exists only as an explicit assertion of that invariant.
//
// It used to fall back to `SHOW WAREHOUSES LIMIT 1` and adopt whatever came
// back. That is a bad fallback in a way that hides itself: the result is
// whichever warehouse happens to sort first in the account, which on a real
// account was COMPUTE_WH -- a LARGE warehouse this stack does not create, does
// not grant to the app roles, and does not pay for. The app would then either
// fail every query on a missing grant or quietly bill a Large warehouse for
// dashboard reads, and in both cases the service still reported healthy. A
// missing warehouse must resolve to a warehouse we OWN, or fail loudly; it must
// never resolve to an arbitrary one.
//
// Imports kept minimal so this can be exercised without spinning up the full
// Express app.

import { SF_WAREHOUSE, setWarehouse, DEFAULT_WAREHOUSE } from '../constants';
import { log } from '../diagnostics';

export async function detectWarehouse(): Promise<void> {
  if (SF_WAREHOUSE) return;
  // Unreachable while SF_WAREHOUSE carries a non-empty default, but keep the
  // assignment so a future change to that default cannot leave the app with no
  // warehouse at all.
  log('WARN', 'SQL', `SF_WAREHOUSE was empty; falling back to ${DEFAULT_WAREHOUSE}`);
  setWarehouse(DEFAULT_WAREHOUSE);
}

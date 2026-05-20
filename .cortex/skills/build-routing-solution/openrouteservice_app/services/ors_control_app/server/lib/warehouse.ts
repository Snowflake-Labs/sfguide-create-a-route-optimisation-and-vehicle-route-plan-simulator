// Warehouse detection helper. Cached on module load via constants.SF_WAREHOUSE.
// Imports kept minimal so this can be exercised without spinning up the full
// Express app.

import { SF_WAREHOUSE, setWarehouse, IS_SPCS, DEFAULT_WAREHOUSE } from '../constants.js';
import { snowSqlLocal, snowSqlSpcs } from './sql.js';

export async function detectWarehouse(): Promise<void> {
  if (SF_WAREHOUSE) return;
  try {
    const rows = IS_SPCS
      ? await snowSqlSpcs('SHOW WAREHOUSES LIMIT 1')
      : snowSqlLocal('SHOW WAREHOUSES LIMIT 1');
    const name = (rows as any[])?.[0]?.name || (rows as any[])?.[0]?.NAME;
    if (name) setWarehouse(name);
    else setWarehouse(DEFAULT_WAREHOUSE);
  } catch {
    setWarehouse(DEFAULT_WAREHOUSE);
  }
}

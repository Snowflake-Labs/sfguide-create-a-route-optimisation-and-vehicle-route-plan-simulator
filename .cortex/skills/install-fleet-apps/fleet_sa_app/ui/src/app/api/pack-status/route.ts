import { NextResponse } from 'next/server';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { query } from '@/lib/snowflake';
import { logger } from '@/lib/logger';
import { withLogging } from '@/lib/api-handler';
import { getServerConfig } from '@/lib/server-config';
import { viewDataRefs, type DataRef, type LayerStatus } from '@/lib/view-deps';
import { findRepairEntry } from '@/lib/missing-dependency';

// Surfacing gate signal. For every <DB>.<SCHEMA> the configured views read
// (every nested query, see lib/view-deps.ts), probe one representative object
// and report the schema as present / absent / unverified, with the label and
// rebuild steps from repair-map.json when absent. The app shows a view whose
// layer is absent as DISABLED with that reason, instead of hiding it with none.
// `schemas` (boolean) and `degraded` are kept for older clients.
// The data-layer DB defaults to FLEET_APP but is config-driven (dataLayer.database).
const DEFAULT_DATA_LAYER_DB = 'FLEET_APP';

// schema -> the object to probe. A plain view/table is preferred; a schema only
// referenced through table functions (LIVE_* UDTFs) used to be skipped
// entirely - never probed, so always "present" - and is now checked in
// INFORMATION_SCHEMA.FUNCTIONS, since `SELECT 1 FROM fn` cannot run.
function collectSchemaProbes(viewsConfig: Record<string, unknown>, db: string): Record<string, DataRef> {
  const probes: Record<string, DataRef> = {};
  for (const def of Object.values(viewsConfig)) {
    for (const ref of viewDataRefs(def, db)) {
      const prev = probes[ref.schema];
      if (!prev || (prev.isFunction && !ref.isFunction)) probes[ref.schema] = ref;
    }
  }
  return probes;
}

async function handleGet() {
  const configPath = process.env.APP_VIEWS_CONFIG;
  const status: Record<string, boolean> = {};
  const layers: Record<string, LayerStatus> = {};
  if (!configPath) return NextResponse.json({ schemas: status, layers, degraded: [] });

  let viewsConfig: Record<string, unknown> = {};
  try {
    const fullPath = configPath.startsWith('/') ? configPath : resolve(process.cwd(), configPath);
    viewsConfig = JSON.parse(readFileSync(fullPath, 'utf-8'));
  } catch (err) {
    logger.error('pack-status-config-load', { path: configPath }, err);
    return NextResponse.json({ schemas: status, layers, degraded: [] });
  }

  const dataLayerDb = getServerConfig().dataLayer?.database ?? DEFAULT_DATA_LAYER_DB;
  const probes = collectSchemaProbes(viewsConfig, dataLayerDb);
  const degraded: string[] = [];
  const absent = (schema: string, fqn: string) => {
    const e = findRepairEntry(fqn);
    layers[schema] = { state: 'absent', object: fqn, label: e?.label ?? e?.layer, fix: e?.fix ?? (e ? [e.action] : undefined), note: e?.note };
    status[schema] = false;
  };
  await Promise.all(
    Object.entries(probes).map(async ([schema, ref]) => {
      const fqn = `${dataLayerDb}.${schema}.${ref.object}`;
      try {
        let present: boolean;
        if (ref.isFunction) {
          // Identifiers cannot be bound into a FROM, but INFORMATION_SCHEMA
          // filters can; the DB name comes from server config, not the client.
          const rows = await query<{ N?: number }>(
            `SELECT COUNT(*) AS N FROM ${dataLayerDb}.INFORMATION_SCHEMA.FUNCTIONS WHERE FUNCTION_SCHEMA = ? AND FUNCTION_NAME = ?`,
            [schema, ref.object],
          );
          present = Number(rows[0]?.N ?? 0) > 0;
        } else {
          const rows = await query<Record<string, unknown>>(`SELECT 1 AS X FROM ${fqn} LIMIT 1`);
          present = rows.length > 0;
        }
        if (present) {
          layers[schema] = { state: 'present', object: fqn };
          status[schema] = true;
        } else {
          absent(schema, fqn);
        }
      } catch (err) {
        // Two very different failures used to land here identically:
        //   (a) the object does not exist or the role cannot see it -> the layer
        //       genuinely is not built, so its views are shown unavailable;
        //   (b) the probe could not COMPLETE - a statement timeout, a busy
        //       warehouse, a transport error. Nothing is known about the pack.
        // Treating (b) as (a) is why every dashboard vanished during a
        // warehouse-contention incident: all four probes timed out, every pack
        // was marked absent, and the UI rendered with no region or date picker
        // as though the deployment were empty. Measured: this endpoint took
        // 112,691 ms with all probes timing out while the views themselves
        // returned in under a second once compute was free.
        const msg = String(err);
        const missing = /does not exist|not authorized|Unknown user-defined|Insufficient privileges/i.test(msg);
        if (missing) {
          logger.warn('pack-status-probe-absent', { schema, fqn, err: msg });
          absent(schema, fqn);
        } else {
          // Could not measure. Keep the pack VISIBLE rather than silently
          // deleting a working dashboard, and tell the caller it is unverified.
          logger.error('pack-status-probe-unverified', { schema, fqn, err: msg });
          degraded.push(schema);
          layers[schema] = { state: 'unverified', object: fqn };
          status[schema] = true;
        }
      }
    }),
  );
  return NextResponse.json({ schemas: status, layers, degraded });
}

export const GET = withLogging(handleGet);

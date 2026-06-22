import { NextResponse } from 'next/server';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { query } from '@/lib/snowflake';
import { logger } from '@/lib/logger';
import { withLogging } from '@/lib/api-handler';
import { getServerConfig } from '@/lib/server-config';

// Surfacing gate signal. A domain pack's dashboards/agent tools should only appear
// when the pack's data resolves. We derive the set of <DB>.<SCHEMA>.<VIEW>
// objects the configured views actually query, probe one representative view per
// schema (LIMIT 1), and return { schema: present }. The app-shell hides views whose
// schema is absent/empty. Mirrors packs/_lib/install.py --probe.
// The data-layer DB defaults to FLEET_APP but is config-driven (dataLayer.database).
const DEFAULT_DATA_LAYER_DB = 'FLEET_APP';

function collectSchemaProbes(
  viewsConfig: Record<string, unknown>,
  db: string,
): Record<string, string> {
  // schema -> a representative fully-qualified view to probe
  const probes: Record<string, string> = {};
  const fqnRe = new RegExp(`${db}\\.([A-Za-z0-9_]+)\\.([A-Za-z0-9_]+)`, 'g');
  const scan = (sql: string) => {
    let m: RegExpExecArray | null;
    fqnRe.lastIndex = 0;
    while ((m = fqnRe.exec(sql)) !== null) {
      const [, schema, view] = m;
      if (!probes[schema]) probes[schema] = `${db}.${schema}.${view}`;
    }
  };
  for (const def of Object.values(viewsConfig)) {
    const areas = (def as { areas?: Record<string, { data?: { query?: string } }> }).areas ?? {};
    for (const area of Object.values(areas)) {
      const q = area?.data?.query;
      if (typeof q === 'string') scan(q);
    }
  }
  return probes;
}

async function handleGet() {
  const configPath = process.env.APP_VIEWS_CONFIG;
  const status: Record<string, boolean> = {};
  if (!configPath) return NextResponse.json({ schemas: status });

  let viewsConfig: Record<string, unknown> = {};
  try {
    const fullPath = configPath.startsWith('/') ? configPath : resolve(process.cwd(), configPath);
    viewsConfig = JSON.parse(readFileSync(fullPath, 'utf-8'));
  } catch (err) {
    logger.error('pack-status-config-load', { path: configPath }, err);
    return NextResponse.json({ schemas: status });
  }

  const dataLayerDb = getServerConfig().dataLayer?.database ?? DEFAULT_DATA_LAYER_DB;
  const probes = collectSchemaProbes(viewsConfig, dataLayerDb);
  await Promise.all(
    Object.entries(probes).map(async ([schema, fqn]) => {
      try {
        const rows = await query<Record<string, unknown>>(`SELECT 1 AS X FROM ${fqn} LIMIT 1`);
        status[schema] = rows.length > 0;
      } catch (err) {
        // Missing object or no access -> treat pack as not present (hidden).
        logger.warn('pack-status-probe-failed', { schema, fqn, err: String(err) });
        status[schema] = false;
      }
    }),
  );
  return NextResponse.json({ schemas: status });
}

export const GET = withLogging(handleGet);

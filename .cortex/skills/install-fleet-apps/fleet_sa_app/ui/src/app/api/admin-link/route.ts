import { NextResponse } from 'next/server';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { withLogging } from '@/lib/api-handler';
import { requireAdmin } from '@/lib/ingress-identity';
import { query } from '@/lib/snowflake';
import { logger } from '@/lib/logger';

// Resolves the FLEET_ADMIN_APP public endpoint URL for admins only. Gated by
// requireAdmin so a non-admin (even one simulating admin in the UI) never
// receives the URL. Fail-soft: any error (admin app not deployed, endpoint not
// yet provisioned, insufficient identity) returns { url: null } so the SA app
// header simply hides the link instead of erroring.

const DEFAULT_SERVICE_FQN = 'FLEET_INTELLIGENCE.SYNAPSE_USER.FLEET_ADMIN_APP';
const DEFAULT_ENDPOINT_NAME = 'fleet-admin-app';

function adminAppTarget(): { serviceFqn: string; endpointName: string } {
  const configPath = process.env.APP_CONFIG;
  if (configPath) {
    try {
      const fullPath = configPath.startsWith('/') ? configPath : resolve(process.cwd(), configPath);
      const cfg = JSON.parse(readFileSync(fullPath, 'utf-8')) as {
        adminApp?: { serviceFqn?: string; endpointName?: string };
      };
      return {
        serviceFqn: cfg.adminApp?.serviceFqn || DEFAULT_SERVICE_FQN,
        endpointName: cfg.adminApp?.endpointName || DEFAULT_ENDPOINT_NAME,
      };
    } catch {
      // fall through to defaults
    }
  }
  return { serviceFqn: DEFAULT_SERVICE_FQN, endpointName: DEFAULT_ENDPOINT_NAME };
}

async function handleGet(req: Request) {
  const gate = await requireAdmin(req);
  if (!gate.ok) {
    return NextResponse.json({ url: null });
  }

  const { serviceFqn, endpointName } = adminAppTarget();
  try {
    const rows = await query<Record<string, unknown>>(`SHOW ENDPOINTS IN SERVICE ${serviceFqn}`);
    const row = rows.find(
      (r) => String((r.name ?? r.NAME ?? '') as string).toLowerCase() === endpointName.toLowerCase(),
    );
    const ingress = row ? String((row.ingress_url ?? row.INGRESS_URL ?? '') as string).trim() : '';
    if (!ingress || ingress.toLowerCase() === 'null') {
      return NextResponse.json({ url: null });
    }
    return NextResponse.json({ url: `https://${ingress}` });
  } catch (err) {
    logger.error('admin-link-resolve', { serviceFqn, endpointName }, err);
    return NextResponse.json({ url: null });
  }
}

export const GET = withLogging(handleGet);

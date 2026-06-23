import { NextRequest, NextResponse } from 'next/server';
import { withLogging } from '@/lib/api-handler';
import { SF_DATABASE } from '@/server/constants';
import { runSql, submitSqlAsync } from '@/server/lib/sql';
import { sanitizeIdentifier, sanitizeFloat, escapeString } from '@/server/lib/sanitize';
import { requireOps } from '@/lib/ingress-identity';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const POST = withLogging(async (req: NextRequest) => {
  const gate = await requireOps(req);
  if (!gate.ok) return NextResponse.json({ error: gate.reason || 'Forbidden' }, { status: gate.status });
  const { city, region, pbf_url, bbox, profiles, compute_size, force_redownload_pbf } = await req.json();
  if (!region) return NextResponse.json({ error: 'region required' }, { status: 400 });

  let safeRegion: string;
  let safeCity: string;
  try {
    safeRegion = sanitizeIdentifier(region);
    safeCity = escapeString(city || region);
    sanitizeFloat(bbox?.minLat); sanitizeFloat(bbox?.maxLat); sanitizeFloat(bbox?.minLon); sanitizeFloat(bbox?.maxLon);
  } catch (err) {
    return NextResponse.json({ error: `Invalid input: ${(err as Error).message}` }, { status: 400 });
  }

  const safePbfUrl = escapeString(pbf_url || '');
  const minLat = sanitizeFloat(bbox.minLat), maxLat = sanitizeFloat(bbox.maxLat);
  const minLon = sanitizeFloat(bbox.minLon), maxLon = sanitizeFloat(bbox.maxLon);
  const defaultProfiles = 'driving-car,driving-hgv,cycling-electric';
  const validProfiles = ['driving-car', 'driving-hgv', 'cycling-regular', 'cycling-road', 'cycling-mountain', 'cycling-electric', 'foot-walking', 'foot-hiking', 'wheelchair'];
  const selectedProfiles = Array.isArray(profiles) ? profiles.filter((p: string) => validProfiles.includes(p)).join(',') : defaultProfiles;
  const safeProfiles = escapeString(selectedProfiles || defaultProfiles);
  const ALLOWED_SIZES = ['S', 'M', 'L', 'XL', 'XXL'];
  const safeComputeSize = ALLOWED_SIZES.includes(compute_size) ? compute_size : 'XXL';
  const safeForceRedownload = force_redownload_pbf === true ? 'TRUE' : 'FALSE';
  const jobId = `PROVISION_${safeRegion}_${Date.now()}`.toUpperCase();

  try {
    await runSql(`INSERT INTO ${SF_DATABASE}.CORE.REGION_PROVISION_JOBS (JOB_ID, REGION, DISPLAY_NAME, PBF_URL, PROFILES, STATUS, STAGE) VALUES ('${escapeString(jobId)}', '${safeRegion}', '${safeCity}', '${safePbfUrl}', '${safeProfiles}', 'PENDING', 'NOT_STARTED')`);
  } catch (err) {
    return NextResponse.json({ error: `Failed to create job: ${(err as Error).message}` }, { status: 500 });
  }

  // Fire-and-forget: launch the long-running provisioning CALL async and record
  // its statement handle, WITHOUT blocking the response. The standalone Node
  // process keeps the event loop alive so the un-awaited promise runs to completion.
  (async () => {
    try {
      const callSql = `CALL ${SF_DATABASE}.CORE.PROVISION_REGION_WRAPPER('${escapeString(jobId)}', '${safeRegion}', '${safeCity}', '${safePbfUrl}', ${minLat}, ${maxLat}, ${minLon}, ${maxLon}, '${safeProfiles}', '${safeComputeSize}', ${safeForceRedownload})`;
      const handle = await submitSqlAsync(callSql);
      await runSql(`UPDATE ${SF_DATABASE}.CORE.REGION_PROVISION_JOBS SET STATEMENT_HANDLE='${escapeString(handle)}' WHERE JOB_ID='${escapeString(jobId)}'`);
    } catch (e) {
      console.error(`[provision] async launch error: ${(e as Error).message}`);
    }
  })();

  return NextResponse.json({ status: 'launched', job_id: jobId });
});

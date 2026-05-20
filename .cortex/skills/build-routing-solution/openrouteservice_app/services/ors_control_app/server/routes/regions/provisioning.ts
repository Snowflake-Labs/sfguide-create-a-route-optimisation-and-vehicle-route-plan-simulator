// Region provisioning lifecycle endpoints — provision, status polling,
// progress, build-progress, cancel, delete, and one-click diagnose.
// All wrap CORE.PROVISION_REGION_WRAPPER / DROP_REGION_ORS / DIAGNOSE_REGION
// procs and surface progress to the build UI.

import { Router } from 'express';
import { SF_DATABASE } from '../../constants.js';
import { runSql, callProcedure, submitSqlAsync, cancelStatement } from '../../lib/sql.js';
import { sanitizeIdentifier, sanitizeFloat, escapeString } from '../../lib/sanitize.js';
import { orsServiceFqn } from '../../lib/region.js';

export function createRegionsProvisioningRouter(): Router {
  const router = Router();

  router.post('/api/regions/provision', async (req, res) => {
    const { city, region, pbf_url, bbox, profiles, compute_size, force_redownload_pbf } = req.body;
    if (!region) return res.status(400).json({ error: 'region required' });

    let safeRegion: string;
    let safeCity: string;
    try {
      safeRegion = sanitizeIdentifier(region);
      safeCity = escapeString(city || region);
      sanitizeFloat(bbox?.minLat);
      sanitizeFloat(bbox?.maxLat);
      sanitizeFloat(bbox?.minLon);
      sanitizeFloat(bbox?.maxLon);
    } catch (err: any) {
      return res.status(400).json({ error: `Invalid input: ${err.message}` });
    }

    const safePbfUrl = escapeString(pbf_url || '');
    const minLat = sanitizeFloat(bbox.minLat);
    const maxLat = sanitizeFloat(bbox.maxLat);
    const minLon = sanitizeFloat(bbox.minLon);
    const maxLon = sanitizeFloat(bbox.maxLon);

    const defaultProfiles = 'driving-car,driving-hgv,cycling-electric';
    const validProfiles = ['driving-car', 'driving-hgv', 'cycling-regular', 'cycling-road', 'cycling-mountain', 'cycling-electric', 'foot-walking', 'foot-hiking', 'wheelchair'];
    const selectedProfiles = Array.isArray(profiles)
      ? profiles.filter((p: string) => validProfiles.includes(p)).join(',')
      : defaultProfiles;
    const safeProfiles = escapeString(selectedProfiles || defaultProfiles);
    // Allow legacy tiers (M/L/XL) for the UI advanced override; default to XXL for any non-city
    // request that arrives without a recognized tier so we never silently downgrade large regions.
    const ALLOWED_SIZES = ['S', 'M', 'L', 'XL', 'XXL'] as const;
    const safeComputeSize = (ALLOWED_SIZES as readonly string[]).includes(compute_size) ? compute_size : 'XXL';
    // PBF cache control: when true, skip the on-stage probe in
    // PROVISION_REGION_WRAPPER and always re-download from the upstream URL.
    const safeForceRedownload = force_redownload_pbf === true ? 'TRUE' : 'FALSE';

    const jobId = `PROVISION_${safeRegion}_${Date.now()}`.toUpperCase();

    try {
      await runSql(`INSERT INTO ${SF_DATABASE}.CORE.REGION_PROVISION_JOBS (JOB_ID, REGION, DISPLAY_NAME, PBF_URL, PROFILES, STATUS, STAGE) VALUES ('${escapeString(jobId)}', '${safeRegion}', '${safeCity}', '${safePbfUrl}', '${safeProfiles}', 'PENDING', 'NOT_STARTED')`);
    } catch (err: any) {
      return res.status(500).json({ error: `Failed to create job: ${err.message}` });
    }

    res.json({ status: 'launched', job_id: jobId });

    try {
      const callSql = `CALL ${SF_DATABASE}.CORE.PROVISION_REGION_WRAPPER('${escapeString(jobId)}', '${safeRegion}', '${safeCity}', '${safePbfUrl}', ${minLat}, ${maxLat}, ${minLon}, ${maxLon}, '${safeProfiles}', '${safeComputeSize}', ${safeForceRedownload})`;
      const handle = await submitSqlAsync(callSql);
      await runSql(`UPDATE ${SF_DATABASE}.CORE.REGION_PROVISION_JOBS SET STATEMENT_HANDLE='${escapeString(handle)}' WHERE JOB_ID='${escapeString(jobId)}'`);
    } catch (e: any) {
      console.error(`[provision] async launch error: ${e.message}`);
    }
  });

  router.get('/api/regions/provision/status', async (_req, res) => {
    try {
      const result = await callProcedure('GET_PROVISION_STATUS()');
      const jobs = JSON.parse(result || '[]');
      res.json({ jobs });
    } catch (err: any) {
      res.json({ jobs: [], error: err.message });
    }
  });

  router.post('/api/regions/provision/:jobId/dismiss', async (req, res) => {
    try {
      const jobId = sanitizeIdentifier(req.params.jobId);
      await callProcedure(`DISMISS_PROVISION_JOB('${jobId}')`);
      res.json({ success: true });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  router.get('/api/regions/:region/progress', async (req, res) => {
    try {
      const safeRegion = sanitizeIdentifier(req.params.region);
      const result = await callProcedure('GET_PROVISION_STATUS()');
      const jobs = JSON.parse(result || '[]');
      const job = jobs.find((j: any) => j.region === safeRegion && (j.status === 'RUNNING' || j.status === 'PENDING'));
      if (job) {
        res.json({ status: job.status === 'RUNNING' ? 'running' : job.status, phase: job.stage.toLowerCase(), message: job.message, error: job.error_msg });
      } else {
        const completed = jobs.find((j: any) => j.region === safeRegion);
        res.json(completed ? { status: completed.status.toLowerCase(), phase: completed.stage.toLowerCase(), message: completed.message } : { status: 'idle', phase: '' });
      }
    } catch { res.json({ status: 'idle', phase: '' }); }
  });

  router.get('/api/regions/:region/build-progress', async (req, res) => {
    try {
      const safeRegion = sanitizeIdentifier(req.params.region);
      const svcName = orsServiceFqn(req.params.region);

      // Fast path: ORS_STATUS is the source of truth. If the service reports ready
      // with profiles loaded, return 'ready' immediately. Avoids unreliable log
      // tail scraping for long-running builds where start/finish markers have
      // rolled out of the 1000-line window (Issue: UI stuck on "ORS starting up...").
      try {
        const statusRows = await runSql(
          `SELECT ${SF_DATABASE}.CORE.ORS_STATUS('${safeRegion}')::VARCHAR AS S`
        );
        const statusRaw = statusRows?.[0]?.S;
        if (statusRaw) {
          const parsed = JSON.parse(statusRaw);
          if (parsed?.service_ready === true && parsed?.profiles) {
            const loaded = Object.keys(parsed.profiles);
            if (loaded.length > 0) {
              res.json({
                phase: 'ready',
                progress: 100,
                completedProfiles: loaded,
                totalProfiles: loaded.length,
                currentProfile: null,
              });
              return;
            }
          }
        }
      } catch {
        // fall through to log-based scraping
      }

      const rows = await runSql(
        `SELECT SYSTEM$GET_SERVICE_LOGS('${svcName}', 0, 'ors', 1000) AS LOGS`
      );
      const logs: string = rows?.[0]?.LOGS || '';

      // ORS v9 logs profile completion as "[N] Profiles: 'name', location: ..." (plural).
      const finishedProfiles = [...logs.matchAll(/\[\d+\] Profiles?: '([\w-]+)'/g)].map(m => m[1]);
      const startedProfiles = [...logs.matchAll(/ORS-pl-([\w-]+)/g)].map(m => m[1]);
      const uniqueStarted = [...new Set(startedProfiles)];
      const totalProfiles = Math.max(uniqueStarted.length, finishedProfiles.length);
      const lastStarted = uniqueStarted.length > 0 ? uniqueStarted[uniqueStarted.length - 1] : null;
      const currentProfile = lastStarted && !finishedProfiles.includes(lastStarted) ? lastStarted : null;

      if (finishedProfiles.length === totalProfiles && totalProfiles > 0 && !currentProfile) {
        const healthOk = logs.includes('Started Application');
        res.json({
          phase: healthOk ? 'ready' : 'finalizing',
          progress: healthOk ? 100 : 99,
          completedProfiles: finishedProfiles,
          totalProfiles,
          currentProfile: null,
        });
        return;
      }

      const nodeLines = [...logs.matchAll(/edge,\s*nodes:\s*([\d\s]+\d),\s*shortcuts:\s*([\d\s]+\d)/g)];

      const profileTagEsc = currentProfile ? `ORS-pl-${currentProfile}`.replace(/[-/]/g, '\\$&') : null;
      const hasImport = profileTagEsc ? new RegExp(`${profileTagEsc}.*?start creating graph`).test(logs) : false;
      const hasCH = profileTagEsc ? new RegExp(`${profileTagEsc}.*?Creating CH preparations`).test(logs) : false;
      const hasLM = profileTagEsc ? new RegExp(`${profileTagEsc}.*?Creating LM preparations`).test(logs) : false;

      if (nodeLines.length === 0 || !hasCH) {
        const started = logs.includes('Starting Application') || logs.includes('Spring Boot');
        let phase = 'waiting';
        if (started) {
          if (hasImport) phase = 'importing';
          else if (currentProfile) phase = 'initializing';
          else phase = 'initializing';
        }
        res.json({
          phase,
          progress: totalProfiles > 0 ? Math.round((finishedProfiles.length / totalProfiles) * 100) : 0,
          completedProfiles: finishedProfiles,
          totalProfiles,
          currentProfile,
        });
        return;
      }

      if (hasLM) {
        const overallProgress = totalProfiles > 0
          ? Math.round(((finishedProfiles.length + 0.95) / totalProfiles) * 100)
          : 95;
        res.json({
          phase: 'building',
          progress: Math.min(overallProgress, 99),
          profileProgress: 95,
          currentProfile,
          completedProfiles: finishedProfiles,
          totalProfiles,
          detail: 'Landmark preparation',
        });
        return;
      }

      const parseNum = (s: string) => parseInt(s.replace(/\s/g, ''), 10);
      const firstNodes = parseNum(nodeLines[0][1]);
      const lastNodes = parseNum(nodeLines[nodeLines.length - 1][1]);
      const profileProgress = firstNodes > 0 ? (1 - lastNodes / firstNodes) : 0;
      const overallProgress = totalProfiles > 0
        ? Math.round(((finishedProfiles.length + profileProgress * 0.9) / totalProfiles) * 100)
        : Math.round(profileProgress * 90);

      res.json({
        phase: 'building',
        progress: Math.min(overallProgress, 99),
        profileProgress: Math.min(Math.round(profileProgress * 100), 99),
        nodesRemaining: lastNodes,
        nodesTotal: firstNodes,
        currentProfile,
        completedProfiles: finishedProfiles,
        totalProfiles,
      });
    } catch (err: any) {
      res.json({ phase: 'unknown', progress: 0, error: err.message });
    }
  });

  router.post('/api/regions/:region/cancel', async (req, res) => {
    try {
      const safeRegion = sanitizeIdentifier(req.params.region);
      const result = await callProcedure('GET_PROVISION_STATUS()');
      const jobs = JSON.parse(result || '[]');
      const active = jobs.find((j: any) => j.region === safeRegion && (j.status === 'RUNNING' || j.status === 'PENDING'));
      if (active?.statement_handle) await cancelStatement(active.statement_handle);
      await runSql(`UPDATE ${SF_DATABASE}.CORE.REGION_PROVISION_JOBS SET STATUS='CANCELLED', COMPLETED_AT=SYSDATE() WHERE REGION='${safeRegion}' AND STATUS IN ('RUNNING','PENDING')`);
      res.json({ status: 'cancelled' });
    } catch (err: any) { res.status(500).json({ error: err.message }); }
  });

  router.delete('/api/regions/:region', async (req, res) => {
    try {
      const safeRegion = sanitizeIdentifier(req.params.region);
      const result = await callProcedure(`DROP_REGION_ORS('${safeRegion}')`);
      await runSql(`UPDATE ${SF_DATABASE}.CORE.REGION_PROVISION_JOBS SET STATUS='CANCELLED', COMPLETED_AT=SYSDATE() WHERE REGION='${safeRegion}' AND STATUS IN ('RUNNING','PENDING')`);
      res.json({ status: 'ok', result });
    } catch (err: any) {
      res.json({ status: 'error', error: err.message });
    }
  });

  // One-click diagnostic agent. Calls DIAGNOSE_REGION which gathers an 8-source
  // snapshot and asks AI_COMPLETE for a markdown diagnosis. 30s server-side cache
  // per region absorbs spam clicks. See docs/plans/in-app-diagnostic-agent.md.
  router.post('/api/regions/:region/diagnose', async (req, res) => {
    let safeRegion: string;
    try {
      safeRegion = sanitizeIdentifier(req.params.region);
    } catch (err: any) {
      return res.status(400).json({ ok: false, error: `Invalid region: ${err.message}` });
    }
    const now = Date.now();
    const cacheKey = `diag:${safeRegion}`;
    const cached = (globalThis as any).__diagCache?.[cacheKey];
    if (cached && now - cached.ts < 30_000) {
      return res.json(cached.payload);
    }
    try {
      const result = await callProcedure(`DIAGNOSE_REGION('${safeRegion}')`);
      const parsed = JSON.parse(result || '{}');
      const payload = { ok: true, ...parsed };
      (globalThis as any).__diagCache = (globalThis as any).__diagCache || {};
      (globalThis as any).__diagCache[cacheKey] = { ts: now, payload };
      res.json(payload);
    } catch (err: any) {
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  return router;
}

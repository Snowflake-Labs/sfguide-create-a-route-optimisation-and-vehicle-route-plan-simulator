// /api/status, /api/config, /api/health, /api/ors-readiness

import { Router } from 'express';
import { SF_DATABASE } from '../constants.js';
import { runSql, callProcedure } from '../lib/sql.js';
import { sanitizeIdentifier } from '../lib/sanitize.js';
import { getExpectedProfiles } from '../lib/ors.js';
import { log } from '../diagnostics.js';

export function createStatusRouter(appVersion: string): Router {
  const router = Router();

  router.get('/api/status', async (_req, res) => {
    try {
      const result = await callProcedure('GET_STATUS()');
      res.json(JSON.parse(result));
    } catch (err: any) {
      log('ERROR', 'Health', `/api/status error: ${err.message?.slice(0, 200)}`);
      res.json({ compute_pool: 'ERROR', services: [], error: err.message });
    }
  });

  router.get('/api/config', (_req, res) => {
    res.json({ database: SF_DATABASE });
  });

  router.get('/api/health', async (_req, res) => {
    const result: Record<string, any> = { healthy: false, version: appVersion, services: {} };
    try {
      const statusRows = await runSql(`SELECT PARSE_JSON(SYSTEM$GET_SERVICE_STATUS('${SF_DATABASE}.CORE.ORS_SERVICE_SANFRANCISCO')) AS S`);
      const raw = statusRows?.[0]?.S;
      const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
      if (Array.isArray(parsed)) {
        result.services.ors = parsed[0]?.status || 'UNKNOWN';
      }
    } catch { result.services.ors = 'ERROR'; }

    try {
      const statusRows = await runSql(`SELECT PARSE_JSON(SYSTEM$GET_SERVICE_STATUS('${SF_DATABASE}.CORE.ROUTING_GATEWAY_SERVICE')) AS S`);
      const raw = statusRows?.[0]?.S;
      const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
      if (Array.isArray(parsed)) {
        result.services.gateway = parsed[0]?.status || 'UNKNOWN';
      }
    } catch { result.services.gateway = 'ERROR'; }

    try {
      const statusRows = await runSql(`SELECT PARSE_JSON(SYSTEM$GET_SERVICE_STATUS('${SF_DATABASE}.CORE.VROOM_SERVICE_SANFRANCISCO')) AS S`);
      const raw = statusRows?.[0]?.S;
      const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
      if (Array.isArray(parsed)) {
        result.services.vroom = parsed[0]?.status || 'UNKNOWN';
      }
    } catch { result.services.vroom = 'ERROR'; }

    try {
      const versionRows = await runSql(`SELECT COMPONENT, VERSION FROM ${SF_DATABASE}.CORE.VERSION_INFO`);
      if (versionRows?.length) {
        result.versions = {};
        for (const row of versionRows) {
          result.versions[row.COMPONENT || row.component] = row.VERSION || row.version;
        }
      }
    } catch {}

    result.healthy = result.services.ors === 'READY' && result.services.gateway === 'READY';
    res.json(result);
  });

  router.get('/api/ors-readiness', async (_req, res) => {
    const readiness: Record<string, any> = {};

    type StageProbe = {
      osm_done: boolean;
      lm_done: boolean;
      ch_done: boolean;
      build_ok: boolean;
      graphs_persisted: boolean;
      profile_artifacts: Record<string, { osm: boolean; lm: boolean; ch: boolean }>;
    };

    const stageProbeCache = new Map<string, { ts: number; probe: StageProbe }>();

    async function probeStage(regionKey: string): Promise<StageProbe> {
      const cached = stageProbeCache.get(regionKey);
      if (cached && Date.now() - cached.ts < 5000) return cached.probe;

      const empty: StageProbe = {
        osm_done: false,
        lm_done: false,
        ch_done: false,
        build_ok: false,
        graphs_persisted: false,
        profile_artifacts: {},
      };

      try {
        const rows = await runSql(`LIST @${SF_DATABASE}.CORE.ORS_GRAPHS_SPCS_STAGE/${regionKey}/`);
        if (!rows || rows.length === 0) {
          stageProbeCache.set(regionKey, { ts: Date.now(), probe: empty });
          return empty;
        }
        const names: string[] = rows.map((r: any) => String(r.name || r.NAME || ''));
        const probe: StageProbe = {
          osm_done: names.some(n => n.endsWith('/_OSM_DONE') || /\/_OSM_DONE(\.|$)/.test(n)),
          lm_done: names.some(n => n.endsWith('/_LM_DONE') || /\/_LM_DONE(\.|$)/.test(n)),
          ch_done: names.some(n => n.endsWith('/_CH_DONE') || /\/_CH_DONE(\.|$)/.test(n)),
          build_ok: names.some(n => n.endsWith('/_BUILD_OK') || /\/_BUILD_OK(\.|$)/.test(n)),
          graphs_persisted: names.some(n => /\/stamp\.txt/.test(n)),
          profile_artifacts: {},
        };
        const profileSet = new Set<string>();
        const trimRegion = regionKey.toLowerCase();
        for (const name of names) {
          const lower = name.toLowerCase();
          const idx = lower.indexOf(`/${trimRegion}/`);
          if (idx < 0) continue;
          const tail = name.slice(idx + 1 + trimRegion.length + 1);
          const seg = tail.split('/')[0];
          if (!seg || seg.startsWith('_')) continue;
          profileSet.add(seg);
        }
        for (const profile of profileSet) {
          const profilePrefix = `/${profile}/`;
          const inProfile = names.filter(n => n.includes(profilePrefix));
          const hasOsm = inProfile.some(n => /\/location_index(\/|$)/.test(n));
          const hasLm = inProfile.some(n => /\/landmarks_.*_with_turn_costs/.test(n));
          const hasChNodes = inProfile.some(n => /\/nodes_ch_/.test(n));
          const hasChShortcuts = inProfile.some(n => /\/shortcuts_/.test(n));
          probe.profile_artifacts[profile] = {
            osm: hasOsm,
            lm: hasLm,
            ch: hasChNodes && hasChShortcuts,
          };
        }
        stageProbeCache.set(regionKey, { ts: Date.now(), probe });
        return probe;
      } catch {
        stageProbeCache.set(regionKey, { ts: Date.now(), probe: empty });
        return empty;
      }
    }

    function phasesFor(profile: string, probe: StageProbe): { osm: string; lm: string; ch: string } {
      if (probe.build_ok) return { osm: 'done', lm: 'done', ch: 'done' };
      const arts = probe.profile_artifacts[profile] || { osm: false, lm: false, ch: false };
      const osm: string = arts.osm || probe.osm_done ? 'done' : 'in_progress';
      let lm: string;
      if (arts.lm || probe.lm_done) lm = 'done';
      else if (osm === 'done') lm = 'in_progress';
      else lm = 'not_started';
      let ch: string;
      if (arts.ch || probe.ch_done) ch = 'done';
      else if (lm === 'done') ch = 'in_progress';
      else ch = 'not_started';
      return { osm, lm, ch };
    }

    async function buildReadiness(regionKey: string, data: any): Promise<any> {
      const builtProfiles = Object.keys(data.profiles || {});
      const expectedProfiles = await getExpectedProfiles(regionKey);
      const allProfiles = [...new Set([...expectedProfiles, ...builtProfiles])];
      const probe = await probeStage(regionKey);
      const graphs = allProfiles.map(p => {
        const ready = builtProfiles.includes(p);
        const phases = ready
          ? { osm: 'done', lm: 'done', ch: 'done' }
          : phasesFor(p, probe);
        return {
          profile: p,
          ready,
          build_date: (data.bounds_info || {})[p]?.graph_build_date || null,
          phases,
        };
      });
      return {
        service_ready: data.service_ready ?? false,
        health_ready: data.health_ready ?? false,
        profiles: builtProfiles,
        expected_profiles: expectedProfiles,
        graphs,
        graphs_persisted: probe.graphs_persisted || probe.build_ok,
        // Forward gateway-side state codes so the UI can distinguish
        // warming-up (graph loading) from suspended / not-provisioned.
        gateway_state: data.error || null,
        gateway_message: data.message || null,
        graph_loading: data.graph_loading === true,
        markers: {
          osm_done: probe.osm_done,
          lm_done: probe.lm_done,
          ch_done: probe.ch_done,
          build_ok: probe.build_ok,
        },
      };
    }

    try {
      const regions = JSON.parse(await callProcedure('LIST_REGIONS()') || '[]');
      for (const r of regions) {
        const safeRegion = sanitizeIdentifier(r.region);
        try {
          const rows = await runSql(`SELECT TO_VARCHAR(${SF_DATABASE}.CORE.ORS_STATUS('${safeRegion}')) AS S`);
          const raw = rows?.[0]?.S;
          if (raw) {
            const data = typeof raw === 'string' ? JSON.parse(raw) : raw;
            readiness[r.region] = await buildReadiness(r.region, data);
          }
        } catch (e: any) {
          readiness[r.region] = { service_ready: false, health_ready: false, error: e.message };
        }
      }
    } catch {}

    res.json(readiness);
  });

  return router;
}

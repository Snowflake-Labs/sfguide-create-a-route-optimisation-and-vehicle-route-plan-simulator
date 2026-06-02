// ORS service-level routing-limits endpoints (per-region, runtime-only).
//
//   GET  /api/regions/:region/ors-limits  — defaults + stored overrides + effective
//   PUT  /api/regions/:region/ors-limits  — persist overrides + apply via restart
//
// These are the limits ORS reads at container start (distances, waypoints,
// snapping radius, visited nodes, matrix routes, isochrone ranges). Applying
// them only requires a suspend/resume of the regional ORS service — never a
// graph rebuild (REBUILD_GRAPHS=false reloads the persisted graph). Persistence
// lives in CORE.REGION_ORS_LIMITS and is re-read by WRITE_ORS_CONFIG, so the
// overrides survive every reprovision (Option A).

import { Router } from 'express';
import { SF_DATABASE } from '../../constants.js';
import { runSql } from '../../lib/sql.js';
import { sanitizeIdentifier } from '../../lib/sanitize.js';

// Allowlist of editable limits with [min, max] bounds. Keys map 1:1 to the
// fields emitted by WRITE_ORS_CONFIG / ORS_LIMIT_DEFAULTS. Anything outside the
// allowlist is ignored; values are coerced to integers so the JSON passed to
// the SQL literal can never contain quotes/backslashes.
const LIMIT_BOUNDS: Record<string, [number, number]> = {
  maximum_distance: [1000, 100000000],
  maximum_distance_dynamic_weights: [1000, 100000000],
  maximum_distance_avoid_areas: [1000, 100000000],
  maximum_distance_alternative_routes: [1000, 100000000],
  maximum_distance_round_trip_routes: [1000, 100000000],
  maximum_visited_nodes: [10000, 1000000000],
  maximum_waypoints: [2, 100000],
  maximum_snapping_radius: [10, 100000],
  matrix_maximum_routes: [100, 100000000],
  matrix_maximum_visited_nodes: [10000, 1000000000],
  isochrones_maximum_locations: [1, 100],
  isochrones_maximum_intervals: [1, 100],
  isochrones_maximum_range_distance: [1000, 100000000],
  isochrones_maximum_range_time: [60, 86400],
};

function validateLimits(input: any): { clean: Record<string, number>; errors: string[] } {
  const clean: Record<string, number> = {};
  const errors: string[] = [];
  if (!input || typeof input !== 'object') return { clean, errors: ['limits object required'] };
  for (const [key, bounds] of Object.entries(LIMIT_BOUNDS)) {
    if (input[key] == null) continue; // omitted -> fall back to default
    const n = Math.round(Number(input[key]));
    if (!Number.isFinite(n)) { errors.push(`${key}: not a number`); continue; }
    const [min, max] = bounds;
    if (n < min || n > max) { errors.push(`${key}: ${n} out of range [${min}, ${max}]`); continue; }
    clean[key] = n;
  }
  return { clean, errors };
}

export function createRegionsLimitsRouter(): Router {
  const router = Router();

  router.get('/api/regions/:region/ors-limits', async (req, res) => {
    try {
      const region = sanitizeIdentifier(req.params.region);
      let defaults: Record<string, number> = {};
      let overrides: Record<string, number> = {};
      try {
        const rows = await runSql(
          `SELECT ${SF_DATABASE}.CORE.ORS_LIMIT_DEFAULTS()::STRING AS DEFAULTS,
                  (SELECT LIMITS::STRING FROM ${SF_DATABASE}.CORE.REGION_ORS_LIMITS
                    WHERE UPPER(REGION) = UPPER('${region}') LIMIT 1) AS OVERRIDES`
        );
        defaults = rows?.[0]?.DEFAULTS ? JSON.parse(rows[0].DEFAULTS) : {};
        overrides = rows?.[0]?.OVERRIDES ? JSON.parse(rows[0].OVERRIDES) : {};
      } catch {
        // Table not present yet (partial deploy): fall back to defaults only.
        const rows = await runSql(`SELECT ${SF_DATABASE}.CORE.ORS_LIMIT_DEFAULTS()::STRING AS DEFAULTS`);
        defaults = rows?.[0]?.DEFAULTS ? JSON.parse(rows[0].DEFAULTS) : {};
      }
      res.json({ region, defaults, overrides, effective: { ...defaults, ...overrides }, bounds: LIMIT_BOUNDS });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  router.put('/api/regions/:region/ors-limits', async (req, res) => {
    try {
      const region = sanitizeIdentifier(req.params.region);
      const { clean, errors } = validateLimits(req.body?.limits ?? req.body);
      if (errors.length) return res.status(400).json({ status: 'error', errors });
      // clean contains only allowlisted integer keys -> safe single-quote literal.
      const json = JSON.stringify(clean);
      const rows = await runSql(`CALL ${SF_DATABASE}.CORE.APPLY_ORS_LIMITS('${region}', '${json}')`);
      const raw = rows?.[0]?.[Object.keys(rows[0] || {})[0]] || '{}';
      const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
      if (parsed.status === 'error') return res.status(400).json(parsed);
      res.json(parsed);
    } catch (err: any) {
      res.status(500).json({ status: 'error', error: err.message });
    }
  });

  return router;
}

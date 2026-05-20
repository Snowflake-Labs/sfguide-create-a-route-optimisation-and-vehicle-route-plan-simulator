// Service lifecycle endpoints: /api/resume, /api/suspend,
// /api/services/:name/(resume|suspend), /api/scale.

import { Router } from 'express';
import { SF_DATABASE } from '../constants.js';
import { runSql, callProcedure } from '../lib/sql.js';
import { sanitizeIdentifier, sanitizeInt, escapeString } from '../lib/sanitize.js';

export function createServicesRouter(): Router {
  const router = Router();

  router.post('/api/resume', async (_req, res) => {
    try {
      const result = await callProcedure('RESUME_ALL_SERVICES()');
      res.json({ status: 'ok', result });
    } catch (err: any) {
      res.json({ status: 'error', error: err.message });
    }
  });

  router.post('/api/suspend', async (_req, res) => {
    try {
      const result = await callProcedure('SUSPEND_ALL_SERVICES()');
      res.json({ status: 'ok', result });
    } catch (err: any) {
      res.json({ status: 'error', error: err.message });
    }
  });

  router.post('/api/services/:name/resume', async (req, res) => {
    try {
      const name = sanitizeIdentifier(req.params.name);
      const rows = await runSql(`CALL ${SF_DATABASE}.CORE.RESUME_SERVICE('${escapeString(name)}')`);
      const raw = rows?.[0]?.[Object.keys(rows[0] || {})[0]] || '{}';
      const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
      if (parsed.status === 'error') return res.status(400).json(parsed);
      res.json(parsed);
    } catch (err: any) {
      res.status(400).json({ status: 'error', error: err.message });
    }
  });

  router.post('/api/services/:name/suspend', async (req, res) => {
    try {
      const name = sanitizeIdentifier(req.params.name);
      if (name.toUpperCase() === 'ORS_CONTROL_APP') {
        return res.status(400).json({ status: 'error', error: 'ORS_CONTROL_APP cannot be suspended from itself' });
      }
      const rows = await runSql(`CALL ${SF_DATABASE}.CORE.SUSPEND_SERVICE('${escapeString(name)}')`);
      const raw = rows?.[0]?.[Object.keys(rows[0] || {})[0]] || '{}';
      const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
      if (parsed.status === 'error') return res.status(400).json(parsed);
      res.json(parsed);
    } catch (err: any) {
      res.status(400).json({ status: 'error', error: err.message });
    }
  });

  router.post('/api/scale', async (req, res) => {
    try {
      const min = sanitizeInt(req.body.min);
      const max = sanitizeInt(req.body.max);
      if (min < 1 || max < min || max > 20) return res.status(400).json({ error: 'min must be 1-20, max >= min' });
      const result = await callProcedure(`SCALE_SERVICES(${min}, ${max})`);
      res.json({ status: 'ok', result });
    } catch (err: any) {
      res.json({ status: 'error', error: err.message });
    }
  });

  return router;
}

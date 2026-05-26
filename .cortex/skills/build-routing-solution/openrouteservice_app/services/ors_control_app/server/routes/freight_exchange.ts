// Freight Exchange enrichment endpoints
//
// Provides ORS road-routing + VROOM optimisation features on top of the
// existing read-only Freight Exchange page (Phase A/B).
//
// Routes:
//   GET    /api/fx/enriched-offers     — VW_OFFER_ENRICHED_V2 with road km/min
//   POST   /api/fx/refresh-routes      — Batch DIRECTIONS for OPEN offers, populates FACT_OFFER_ROUTES (Phase E1)
//   POST   /api/fx/eta                 — On-demand DIRECTIONS for trailer -> offer pickup (Phase E1/E2)
//   POST   /api/fx/isochrone           — ISOCHRONES from trailer for reachability filter (Phase E2)
//   POST   /api/fx/refresh-deadhead    — Batch MATRIX trailer.last_drop -> offer.pickup, populates FACT_DEADHEAD_MATRIX (Phase E3)
//   GET    /api/fx/deadhead            — VW_OFFER_DEADHEAD read for active region
//   POST   /api/fx/round-trip          — 1-vehicle/2-shipment OPTIMIZATION (Phase E4)
//   POST   /api/fx/bundle              — N-shipment OPTIMIZATION with EU 561 break (Phase E5)
//   GET    /api/fx/lane-density        — VW_LANE_DENSITY H3 heatmap (Phase E7)
//   POST   /api/fx/draft-counter       — Cortex Complete negotiation draft + suggested USD (Phase E8)
//   POST   /api/fx/decisions           — Write accepted decision to PROPOSAL_DECISIONS with SOURCE_PAGE='FREIGHT_EXCHANGE'
//
// Tracking: every SQL call sets query_tag = oss-freight-exchange v1.1.

import { Router } from 'express';
import { runSql } from '../lib/sql.js';
import { escapeString, sanitizeFloat, sanitizeInt } from '../lib/sanitize.js';
import { safeRegionIdent, normalizeRegion } from '../lib/region.js';
import { log } from '../diagnostics.js';

const QUERY_TAG = `'{"origin":"sf_sit-is-fleet","name":"oss-freight-exchange","version":{"major":1,"minor":1},"attributes":{"is_quickstart":1,"source":"app"}}'`;

async function setQueryTag(): Promise<void> {
  try {
    await runSql(`ALTER SESSION SET query_tag = ${QUERY_TAG}`);
  } catch {
    /* non-fatal */
  }
}

// Resolve the active region from MARKETPLACE.CONFIG (kept in sync with the
// Control App's preset by region-sync.ts).
async function activeRegion(): Promise<string> {
  const rows = await runSql(`SELECT REGION FROM FLEET_INTELLIGENCE.MARKETPLACE.CONFIG LIMIT 1`);
  return String(rows?.[0]?.REGION ?? 'SanFrancisco');
}

// Pick HGV profile for heavy presets, fall back to driving-car otherwise.
// Phase E6 will branch this on EQUIPMENT/HAZMAT.
function profileFor(_region: string, vehicleType?: string): string {
  if (!vehicleType) return 'driving-hgv';
  const v = vehicleType.toLowerCase();
  if (v.includes('truck') || v.includes('hgv') || v.includes('lorry')) return 'driving-hgv';
  if (v.includes('bike') || v.includes('cycle')) return 'cycling-electric';
  return 'driving-car';
}

export function createFreightExchangeRouter(): Router {
  const router = Router();

  // -------------------------------------------------------------------------
  // GET /api/fx/enriched-offers — read VW_OFFER_ENRICHED_V2
  // -------------------------------------------------------------------------
  router.get('/api/fx/enriched-offers', async (req, res) => {
    try {
      await setQueryTag();
      const limit = sanitizeInt(req.query.limit ?? 500);
      const rows = await runSql(`
        SELECT *
        FROM FLEET_INTELLIGENCE.MARKETPLACE.VW_OFFER_ENRICHED_V2
        WHERE STATUS = 'OPEN'
        ORDER BY POSTED_AT DESC
        LIMIT ${limit}
      `);
      res.json({ offers: rows });
    } catch (e: any) {
      log('ERROR', 'FreightExchange', `enriched-offers: ${e?.message || e}`);
      res.status(500).json({ error: String(e?.message || e) });
    }
  });

  // -------------------------------------------------------------------------
  // POST /api/fx/refresh-routes — Phase E1
  // Body: { batchSize?: number, maxAgeHours?: number, vehicleType?: string }
  // -------------------------------------------------------------------------
  router.post('/api/fx/refresh-routes', async (req, res) => {
    try {
      await setQueryTag();
      const batchSize = sanitizeInt(req.body?.batchSize ?? 50);
      const maxAgeHours = sanitizeInt(req.body?.maxAgeHours ?? 6);
      const region = await activeRegion();
      const profile = profileFor(region, req.body?.vehicleType);

      const stale = await runSql(`
        SELECT o.OFFER_ID, o.PICKUP_LON, o.PICKUP_LAT, o.DROPOFF_LON, o.DROPOFF_LAT
        FROM FLEET_INTELLIGENCE.MARKETPLACE.VW_OFFERS o
        LEFT JOIN FLEET_INTELLIGENCE.MARKETPLACE.FACT_OFFER_ROUTES fr USING (OFFER_ID)
        WHERE o.STATUS = 'OPEN'
          AND (fr.OFFER_ID IS NULL OR fr.COMPUTED_AT < DATEADD(hour, -${maxAgeHours}, CURRENT_TIMESTAMP()))
          AND o.PICKUP_LON IS NOT NULL AND o.DROPOFF_LON IS NOT NULL
        LIMIT ${batchSize}
      `);

      let processed = 0, failed = 0;
      const safeRegion = safeRegionIdent(normalizeRegion(region));

      for (const r of stale as any[]) {
        try {
          const sql = `
            SELECT
              OPENROUTESERVICE_APP.CORE.DIRECTIONS(
                ARRAY_CONSTRUCT(
                  ARRAY_CONSTRUCT(${sanitizeFloat(String(r.PICKUP_LON))},  ${sanitizeFloat(String(r.PICKUP_LAT))}),
                  ARRAY_CONSTRUCT(${sanitizeFloat(String(r.DROPOFF_LON))}, ${sanitizeFloat(String(r.DROPOFF_LAT))})
                ),
                '${escapeString(profile)}',
                '${safeRegion}'
              ) AS D
          `;
          const rows = await runSql(sql);
          const raw = rows?.[0]?.D;
          const d = typeof raw === 'string' ? JSON.parse(raw) : raw;
          const route = d?.routes?.[0];
          if (!route) {
            failed++;
            continue;
          }
          const km = Number(route.summary?.distance ?? 0) / 1000;
          const min = Number(route.summary?.duration ?? 0) / 60;
          const geom = JSON.stringify(route.geometry ?? null);
          await runSql(`
            MERGE INTO FLEET_INTELLIGENCE.MARKETPLACE.FACT_OFFER_ROUTES tgt
            USING (SELECT '${escapeString(String(r.OFFER_ID))}' AS OFFER_ID) src
              ON tgt.OFFER_ID = src.OFFER_ID
            WHEN MATCHED THEN UPDATE SET
              ROAD_KM = ${km}, ROAD_MIN = ${min},
              GEOMETRY = $$${geom}$$,
              PROFILE = '${escapeString(profile)}',
              COMPUTED_AT = CURRENT_TIMESTAMP()
            WHEN NOT MATCHED THEN INSERT (OFFER_ID, ROAD_KM, ROAD_MIN, GEOMETRY, PROFILE, COMPUTED_AT)
              VALUES ('${escapeString(String(r.OFFER_ID))}', ${km}, ${min}, $$${geom}$$, '${escapeString(profile)}', CURRENT_TIMESTAMP())
          `);
          processed++;
        } catch (e: any) {
          log('WARN', 'FreightExchange', `refresh-routes ${r.OFFER_ID}: ${e?.message || e}`);
          failed++;
        }
      }
      res.json({ processed, failed, region, profile });
    } catch (e: any) {
      log('ERROR', 'FreightExchange', `refresh-routes: ${e?.message || e}`);
      res.status(500).json({ error: String(e?.message || e) });
    }
  });

  // -------------------------------------------------------------------------
  // POST /api/fx/eta — Phase E1
  // Body: { trailerLon, trailerLat, offerId }
  // -------------------------------------------------------------------------
  router.post('/api/fx/eta', async (req, res) => {
    try {
      await setQueryTag();
      const tLon = sanitizeFloat(String(req.body?.trailerLon));
      const tLat = sanitizeFloat(String(req.body?.trailerLat));
      const offerId = escapeString(String(req.body?.offerId ?? ''));
      if (!offerId) return res.status(400).json({ error: 'offerId required' });

      const offerRows = await runSql(`
        SELECT PICKUP_LON, PICKUP_LAT FROM FLEET_INTELLIGENCE.MARKETPLACE.VW_OFFERS
        WHERE OFFER_ID = '${offerId}' LIMIT 1
      `);
      const o: any = offerRows?.[0];
      if (!o) return res.status(404).json({ error: 'offer not found' });

      const region = await activeRegion();
      const safeRegion = safeRegionIdent(normalizeRegion(region));
      const profile = profileFor(region, req.body?.vehicleType);

      const rows = await runSql(`
        SELECT OPENROUTESERVICE_APP.CORE.DIRECTIONS(
          ARRAY_CONSTRUCT(
            ARRAY_CONSTRUCT(${tLon}, ${tLat}),
            ARRAY_CONSTRUCT(${sanitizeFloat(String(o.PICKUP_LON))}, ${sanitizeFloat(String(o.PICKUP_LAT))})
          ),
          '${escapeString(profile)}',
          '${safeRegion}'
        ) AS D
      `);
      const raw = rows?.[0]?.D;
      const d = typeof raw === 'string' ? JSON.parse(raw) : raw;
      const route = d?.routes?.[0];
      res.json({
        offerId: req.body?.offerId,
        roadKm: route ? Number(route.summary?.distance ?? 0) / 1000 : null,
        roadMin: route ? Number(route.summary?.duration ?? 0) / 60 : null,
        geometry: route?.geometry ?? null,
      });
    } catch (e: any) {
      log('ERROR', 'FreightExchange', `eta: ${e?.message || e}`);
      res.status(500).json({ error: String(e?.message || e) });
    }
  });

  // -------------------------------------------------------------------------
  // POST /api/fx/isochrone — Phase E2
  // Body: { trailerLon, trailerLat, rangeSeconds }
  // -------------------------------------------------------------------------
  router.post('/api/fx/isochrone', async (req, res) => {
    try {
      await setQueryTag();
      const tLon = sanitizeFloat(String(req.body?.trailerLon));
      const tLat = sanitizeFloat(String(req.body?.trailerLat));
      const rangeSec = sanitizeInt(req.body?.rangeSeconds ?? 14400);
      const region = await activeRegion();
      const safeRegion = safeRegionIdent(normalizeRegion(region));
      const profile = profileFor(region, req.body?.vehicleType);

      const rows = await runSql(`
        SELECT OPENROUTESERVICE_APP.CORE.ISOCHRONES(
          ARRAY_CONSTRUCT(ARRAY_CONSTRUCT(${tLon}, ${tLat})),
          '${escapeString(profile)}',
          ARRAY_CONSTRUCT(${rangeSec}),
          'time',
          '${safeRegion}'
        ) AS ISO
      `);
      const raw = rows?.[0]?.ISO;
      const iso = typeof raw === 'string' ? JSON.parse(raw) : raw;
      res.json({ isochrone: iso, rangeSeconds: rangeSec, profile, region });
    } catch (e: any) {
      log('ERROR', 'FreightExchange', `isochrone: ${e?.message || e}`);
      res.status(500).json({ error: String(e?.message || e) });
    }
  });

  // -------------------------------------------------------------------------
  // GET /api/fx/deadhead — Phase E3 (read VW_OFFER_DEADHEAD)
  // -------------------------------------------------------------------------
  router.get('/api/fx/deadhead', async (_req, res) => {
    try {
      await setQueryTag();
      const rows = await runSql(`
        SELECT *
        FROM FLEET_INTELLIGENCE.MARKETPLACE.VW_OFFER_DEADHEAD
        WHERE BEST_TRAILER_ID IS NOT NULL
        ORDER BY BEST_DEADHEAD_KM ASC
        LIMIT 1000
      `);
      res.json({ rows });
    } catch (e: any) {
      log('ERROR', 'FreightExchange', `deadhead: ${e?.message || e}`);
      res.status(500).json({ error: String(e?.message || e) });
    }
  });

  // -------------------------------------------------------------------------
  // POST /api/fx/refresh-deadhead — Phase E3
  // Body: { topNTrailers?: number, topNOffers?: number }
  // Computes a small MATRIX trailer.last_drop -> offer.pickup, persists.
  // -------------------------------------------------------------------------
  router.post('/api/fx/refresh-deadhead', async (req, res) => {
    try {
      await setQueryTag();
      const topT = sanitizeInt(req.body?.topNTrailers ?? 10);
      const topO = sanitizeInt(req.body?.topNOffers ?? 30);
      const region = await activeRegion();
      const safeRegion = safeRegionIdent(normalizeRegion(region));
      const profile = profileFor(region, req.body?.vehicleType);

      const trailers = await runSql(`
        SELECT TRAILER_ID, DROPOFF_LON AS LON, DROPOFF_LAT AS LAT
        FROM FLEET_INTELLIGENCE.BACKLOAD_MATCHING.VW_TRAILERS
        WHERE DROPOFF_LON IS NOT NULL
        ORDER BY ETA_TS DESC NULLS LAST
        LIMIT ${topT}
      `);
      const offers = await runSql(`
        SELECT OFFER_ID, PICKUP_LON AS LON, PICKUP_LAT AS LAT
        FROM FLEET_INTELLIGENCE.MARKETPLACE.VW_OFFERS
        WHERE STATUS = 'OPEN' AND PICKUP_LON IS NOT NULL
        ORDER BY POSTED_AT DESC
        LIMIT ${topO}
      `);

      if (!trailers.length || !offers.length) {
        return res.json({ trailers: trailers.length, offers: offers.length, matrix: 0 });
      }

      const tCoords = (trailers as any[]).map(t => `ARRAY_CONSTRUCT(${sanitizeFloat(String(t.LON))}, ${sanitizeFloat(String(t.LAT))})`).join(',');
      const oCoords = (offers as any[]).map(o => `ARRAY_CONSTRUCT(${sanitizeFloat(String(o.LON))}, ${sanitizeFloat(String(o.LAT))})`).join(',');
      const tIdx = (trailers as any[]).map((_, i) => i).join(',');
      const oIdx = (offers as any[]).map((_, i) => i + trailers.length).join(',');

      const sql = `
        SELECT OPENROUTESERVICE_APP.CORE.MATRIX(
          ARRAY_CONSTRUCT(${tCoords}, ${oCoords}),
          '${escapeString(profile)}',
          ARRAY_CONSTRUCT(${tIdx}),
          ARRAY_CONSTRUCT(${oIdx}),
          ARRAY_CONSTRUCT('distance','duration'),
          '${safeRegion}'
        ) AS M
      `;
      const rows = await runSql(sql);
      const raw = rows?.[0]?.M;
      const m = typeof raw === 'string' ? JSON.parse(raw) : raw;
      const dist = m?.distances ?? [];
      const dur = m?.durations ?? [];

      let written = 0;
      for (let i = 0; i < trailers.length; i++) {
        for (let j = 0; j < offers.length; j++) {
          const km = (dist?.[i]?.[j] ?? null);
          const sec = (dur?.[i]?.[j] ?? null);
          if (km == null || sec == null) continue;
          const trailerId = escapeString(String((trailers as any[])[i].TRAILER_ID));
          const offerId = escapeString(String((offers as any[])[j].OFFER_ID));
          await runSql(`
            MERGE INTO FLEET_INTELLIGENCE.MARKETPLACE.FACT_DEADHEAD_MATRIX tgt
            USING (SELECT '${trailerId}' AS TRAILER_ID, '${offerId}' AS OFFER_ID) src
              ON tgt.TRAILER_ID = src.TRAILER_ID AND tgt.OFFER_ID = src.OFFER_ID
            WHEN MATCHED THEN UPDATE SET
              ROAD_KM = ${km / 1000}, ROAD_MIN = ${sec / 60}, COMPUTED_AT = CURRENT_TIMESTAMP()
            WHEN NOT MATCHED THEN INSERT (TRAILER_ID, OFFER_ID, ROAD_KM, ROAD_MIN, COMPUTED_AT)
              VALUES ('${trailerId}', '${offerId}', ${km / 1000}, ${sec / 60}, CURRENT_TIMESTAMP())
          `);
          written++;
        }
      }
      res.json({ trailers: trailers.length, offers: offers.length, matrix: written });
    } catch (e: any) {
      log('ERROR', 'FreightExchange', `refresh-deadhead: ${e?.message || e}`);
      res.status(500).json({ error: String(e?.message || e) });
    }
  });

  // -------------------------------------------------------------------------
  // POST /api/fx/round-trip — Phase E4
  // Body: { trailerId, offerId, returnCandidateIds: string[] }
  // -------------------------------------------------------------------------
  router.post('/api/fx/round-trip', async (req, res) => {
    try {
      await setQueryTag();
      const trailerId = escapeString(String(req.body?.trailerId ?? ''));
      const offerId = escapeString(String(req.body?.offerId ?? ''));
      const candidateIds: string[] = Array.isArray(req.body?.returnCandidateIds) ? req.body.returnCandidateIds : [];
      if (!trailerId || !offerId) return res.status(400).json({ error: 'trailerId and offerId required' });

      const region = await activeRegion();
      const safeRegion = safeRegionIdent(normalizeRegion(region));
      const profile = profileFor(region, req.body?.vehicleType);

      const tRows = await runSql(`
        SELECT TRAILER_ID, DROPOFF_LON, DROPOFF_LAT, HOME_LON, HOME_LAT
        FROM FLEET_INTELLIGENCE.BACKLOAD_MATCHING.VW_TRAILERS
        WHERE TRAILER_ID = '${trailerId}' LIMIT 1
      `);
      const t: any = tRows?.[0];
      if (!t) return res.status(404).json({ error: 'trailer not found' });

      const offerRows = await runSql(`
        SELECT OFFER_ID, PICKUP_LON, PICKUP_LAT, DROPOFF_LON, DROPOFF_LAT, PRICE_USD, WEIGHT_KG
        FROM FLEET_INTELLIGENCE.MARKETPLACE.VW_OFFER_ENRICHED
        WHERE OFFER_ID IN ('${offerId}'${candidateIds.length ? ',' + candidateIds.map(c => `'${escapeString(String(c))}'`).join(',') : ''})
      `);

      const primary = (offerRows as any[]).find(o => o.OFFER_ID === req.body.offerId);
      const candidates = (offerRows as any[]).filter(o => o.OFFER_ID !== req.body.offerId);
      if (!primary) return res.status(404).json({ error: 'primary offer not found' });

      const shipments = [primary, ...candidates].map((o, idx) => ({
        pickup:   { id: idx + 1, location: [Number(o.PICKUP_LON), Number(o.PICKUP_LAT)], service: 1800 },
        delivery: { id: idx + 1, location: [Number(o.DROPOFF_LON), Number(o.DROPOFF_LAT)], service: 600 },
        amount:   [Math.round(Number(o.WEIGHT_KG ?? 12000))],
        priority: o.OFFER_ID === req.body.offerId ? 100 : 50,
      }));
      const vehicle = {
        id: 1,
        profile,
        start: [Number(t.DROPOFF_LON), Number(t.DROPOFF_LAT)],
        end:   [Number(t.HOME_LON), Number(t.HOME_LAT)],
        capacity: [24000],
        max_tasks: 2,
      };
      const payload = { vehicles: [vehicle], shipments, options: { g: true } };
      const payloadStr = JSON.stringify(payload).replace(/'/g, "''");

      const rows = await runSql(`
        SELECT OPENROUTESERVICE_APP.CORE.OPTIMIZATION(PARSE_JSON($$${payloadStr}$$), '${safeRegion}') AS R
      `);
      const raw = rows?.[0]?.R;
      const result = typeof raw === 'string' ? JSON.parse(raw) : raw;
      res.json({ vrp: result, primary, candidates });
    } catch (e: any) {
      log('ERROR', 'FreightExchange', `round-trip: ${e?.message || e}`);
      res.status(500).json({ error: String(e?.message || e) });
    }
  });

  // -------------------------------------------------------------------------
  // POST /api/fx/bundle — Phase E5 (multi-offer solver with EU 561 break)
  // Body: { trailerId, offerIds: string[] }
  // -------------------------------------------------------------------------
  router.post('/api/fx/bundle', async (req, res) => {
    try {
      await setQueryTag();
      const trailerId = escapeString(String(req.body?.trailerId ?? ''));
      const offerIds: string[] = Array.isArray(req.body?.offerIds) ? req.body.offerIds : [];
      if (!trailerId || offerIds.length < 2) return res.status(400).json({ error: 'trailerId and >=2 offerIds required' });

      const region = await activeRegion();
      const safeRegion = safeRegionIdent(normalizeRegion(region));
      const profile = profileFor(region, req.body?.vehicleType);

      const tRows = await runSql(`
        SELECT DROPOFF_LON, DROPOFF_LAT, HOME_LON, HOME_LAT
        FROM FLEET_INTELLIGENCE.BACKLOAD_MATCHING.VW_TRAILERS WHERE TRAILER_ID = '${trailerId}' LIMIT 1
      `);
      const t: any = tRows?.[0];
      if (!t) return res.status(404).json({ error: 'trailer not found' });

      const offerList = offerIds.map(id => `'${escapeString(String(id))}'`).join(',');
      const offerRows = await runSql(`
        SELECT OFFER_ID, PICKUP_LON, PICKUP_LAT, DROPOFF_LON, DROPOFF_LAT, PRICE_USD, WEIGHT_KG, HAZMAT, ADR_CLASS
        FROM FLEET_INTELLIGENCE.MARKETPLACE.VW_OFFER_ENRICHED
        WHERE OFFER_ID IN (${offerList})
      `);

      const anyHazmat = (offerRows as any[]).some(o => o.HAZMAT === true || o.HAZMAT === 'true');

      const shipments = (offerRows as any[]).map((o, idx) => ({
        pickup:   { id: idx + 1, location: [Number(o.PICKUP_LON), Number(o.PICKUP_LAT)], service: 1800 },
        delivery: { id: idx + 1, location: [Number(o.DROPOFF_LON), Number(o.DROPOFF_LAT)], service: 600 },
        amount:   [Math.round(Number(o.WEIGHT_KG ?? 12000))],
      }));

      // EU 561/2006: 45-min break after 4.5 hours (16200s) of driving.
      const now = Math.floor(Date.now() / 1000);
      const vehicle: any = {
        id: 1,
        profile,
        start: [Number(t.DROPOFF_LON), Number(t.DROPOFF_LAT)],
        end:   [Number(t.HOME_LON), Number(t.HOME_LAT)],
        capacity: [24000],
        max_tasks: offerRows.length,
        max_travel_time: 9 * 3600,
        breaks: [{
          id: 1,
          service: 2700,
          time_windows: [[now + 16200, now + 16200 + 5400]],
        }],
      };
      // Phase E6: ADR-aware routing — avoid ferries + tunnels for hazmat bundles.
      if (anyHazmat) {
        vehicle.profile_options = { avoid_features: ['ferries', 'tunnels'] };
      }
      const payload = { vehicles: [vehicle], shipments, options: { g: true } };
      const payloadStr = JSON.stringify(payload).replace(/'/g, "''");

      const rows = await runSql(`
        SELECT OPENROUTESERVICE_APP.CORE.OPTIMIZATION(PARSE_JSON($$${payloadStr}$$), '${safeRegion}') AS R
      `);
      const raw = rows?.[0]?.R;
      const result = typeof raw === 'string' ? JSON.parse(raw) : raw;

      // EU compliance flag: at least one break inserted in the route?
      const route = result?.routes?.[0];
      const breakSteps = (route?.steps ?? []).filter((s: any) => s.type === 'break');
      res.json({
        vrp: result,
        eu561Compliant: breakSteps.length > 0 || (route?.duration ?? 0) <= 16200,
        offers: offerRows,
      });
    } catch (e: any) {
      log('ERROR', 'FreightExchange', `bundle: ${e?.message || e}`);
      res.status(500).json({ error: String(e?.message || e) });
    }
  });

  // -------------------------------------------------------------------------
  // GET /api/fx/lane-density — Phase E7
  // -------------------------------------------------------------------------
  router.get('/api/fx/lane-density', async (_req, res) => {
    try {
      await setQueryTag();
      const rows = await runSql(`
        SELECT H3_CELL, EQUIPMENT, SHIPMENT_COUNT
        FROM FLEET_INTELLIGENCE.MARKETPLACE.VW_LANE_DENSITY
        ORDER BY SHIPMENT_COUNT DESC
        LIMIT 5000
      `);
      res.json({ cells: rows });
    } catch (e: any) {
      log('ERROR', 'FreightExchange', `lane-density: ${e?.message || e}`);
      res.status(500).json({ error: String(e?.message || e) });
    }
  });

  // -------------------------------------------------------------------------
  // POST /api/fx/draft-counter — Phase E8 (Cortex Complete negotiation draft)
  // Body: { offerId, dispatcherId? }
  // -------------------------------------------------------------------------
  router.post('/api/fx/draft-counter', async (req, res) => {
    try {
      await setQueryTag();
      const offerId = escapeString(String(req.body?.offerId ?? ''));
      const dispatcherId = req.body?.dispatcherId ? escapeString(String(req.body.dispatcherId)) : null;
      if (!offerId) return res.status(400).json({ error: 'offerId required' });

      const ctxRows = await runSql(`
        SELECT
          OFFER_ID, PARTNER_NAME, PARTNER_COUNTRY, EQUIPMENT, ADR_CLASS, PRODUCT,
          PICKUP_CITY, DROPOFF_CITY, DISTANCE_KM, PRICE_USD, PRICE_PER_KM_USD,
          TRUST_BADGE, MARKET_BADGE, MARKET_P25, MARKET_P50, MARKET_P75, PRICE_DELTA_PCT
        FROM FLEET_INTELLIGENCE.MARKETPLACE.VW_OFFER_ENRICHED
        WHERE OFFER_ID = '${offerId}' LIMIT 1
      `);
      const c: any = ctxRows?.[0];
      if (!c) return res.status(404).json({ error: 'offer not found' });

      const prompt = `You are a freight dispatcher. Draft a 2-line, professional counter-offer for partner ${c.PARTNER_NAME} (${c.PARTNER_COUNTRY}). ` +
        `Lane: ${c.PICKUP_CITY} -> ${c.DROPOFF_CITY}, ${c.DISTANCE_KM}km, ${c.EQUIPMENT}${c.ADR_CLASS ? ` ADR class ${c.ADR_CLASS}` : ''}. ` +
        `Their offer: $${c.PRICE_USD} ($${c.PRICE_PER_KM_USD}/km). ` +
        `Market this week: p25=$${c.MARKET_P25}, p50=$${c.MARKET_P50}, p75=$${c.MARKET_P75}/km. ` +
        `Price delta vs p50: ${c.PRICE_DELTA_PCT}%. Trust: ${c.TRUST_BADGE}. Market badge: ${c.MARKET_BADGE}. ` +
        `Suggest one specific counter-USD value that respects the corridor p50 and the trust signal. Output: 2 sentences max.`;

      const completionRows = await runSql(`
        SELECT SNOWFLAKE.CORTEX.COMPLETE(
          'mistral-large2',
          $$${prompt.replace(/\$/g, '\\$')}$$
        ) AS DRAFT
      `);
      const draft = String(completionRows?.[0]?.DRAFT ?? '').trim();
      const usdMatch = draft.match(/\$([0-9]+(?:\.[0-9]+)?)/);
      const suggestedUsd = usdMatch ? Number(usdMatch[1]) : null;

      const ctxJson = JSON.stringify(c).replace(/'/g, "''");
      const draftEsc = draft.replace(/'/g, "''");
      await runSql(`
        INSERT INTO FLEET_INTELLIGENCE.MARKETPLACE.OFFER_DRAFTS
          (OFFER_ID, DISPATCHER_ID, DRAFT_TEXT, SUGGESTED_USD, PROMPT_CONTEXT, MODEL)
        SELECT '${offerId}', ${dispatcherId ? `'${dispatcherId}'` : 'NULL'},
               $$${draftEsc}$$,
               ${suggestedUsd ?? 'NULL'},
               PARSE_JSON($$${ctxJson}$$),
               'mistral-large2'
      `);

      res.json({ draft, suggestedUsd, context: c });
    } catch (e: any) {
      log('ERROR', 'FreightExchange', `draft-counter: ${e?.message || e}`);
      res.status(500).json({ error: String(e?.message || e) });
    }
  });

  // -------------------------------------------------------------------------
  // POST /api/fx/decisions — write to shared PROPOSAL_DECISIONS
  // Body: { trailerId?, offerId?, decisionType, bundleId?, score?, emptyKm?, decidedBy?, rationale?, netBenefitEur? }
  // -------------------------------------------------------------------------
  router.post('/api/fx/decisions', async (req, res) => {
    try {
      await setQueryTag();
      const decisionType = escapeString(String(req.body?.decisionType ?? 'SINGLE'));
      if (!['SINGLE', 'ROUND_TRIP', 'BUNDLE'].includes(decisionType)) {
        return res.status(400).json({ error: 'decisionType must be SINGLE | ROUND_TRIP | BUNDLE' });
      }
      const trailerId = req.body?.trailerId ? `'${escapeString(String(req.body.trailerId))}'` : 'NULL';
      const offerId   = req.body?.offerId   ? `'${escapeString(String(req.body.offerId))}'`   : 'NULL';
      const bundleId  = req.body?.bundleId  ? `'${escapeString(String(req.body.bundleId))}'`  : 'NULL';
      const score     = req.body?.score != null ? sanitizeFloat(String(req.body.score)) : 'NULL';
      const emptyKm   = req.body?.emptyKm != null ? sanitizeFloat(String(req.body.emptyKm)) : 'NULL';
      const netBenefit = req.body?.netBenefitEur != null ? sanitizeFloat(String(req.body.netBenefitEur)) : 'NULL';
      const decidedBy = req.body?.decidedBy ? `'${escapeString(String(req.body.decidedBy))}'` : 'NULL';
      const rationale = req.body?.rationale ? `$$${String(req.body.rationale).replace(/\$/g, '\\$')}$$` : 'NULL';

      await runSql(`
        INSERT INTO FLEET_INTELLIGENCE.BACKLOAD_MATCHING.PROPOSAL_DECISIONS
          (TRAILER_ID, OFFER_ID, SOURCE, SCORE, EMPTY_KM, DECIDED_BY, RATIONALE, NET_BENEFIT_EUR, SOURCE_PAGE, DECISION_TYPE, BUNDLE_ID)
        SELECT ${trailerId}, ${offerId}, 'FREIGHT_EXCHANGE', ${score}, ${emptyKm},
               ${decidedBy}, ${rationale}, ${netBenefit},
               'FREIGHT_EXCHANGE', '${decisionType}', ${bundleId}
      `);
      res.json({ ok: true });
    } catch (e: any) {
      log('ERROR', 'FreightExchange', `decisions: ${e?.message || e}`);
      res.status(500).json({ error: String(e?.message || e) });
    }
  });

  return router;
}

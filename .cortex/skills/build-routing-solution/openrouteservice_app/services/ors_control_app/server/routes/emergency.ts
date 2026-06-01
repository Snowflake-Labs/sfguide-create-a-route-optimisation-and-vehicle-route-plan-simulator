// /api/emergency/* -- routes for the emergency-response demo skill (5 React pages).
//
// Backed by:
//   - EMERGENCY_RESPONSE.PIPELINE.STG_NWS_ACTIVE_ALERTS
//   - EMERGENCY_RESPONSE.PIPELINE.FACT_IMPACTED_PARTICIPANTS
//   - EMERGENCY_RESPONSE.PIPELINE.FACT_HAZARD_HISTORY_H3
//   - EMERGENCY_RESPONSE.CORE.{PARTICIPANTS,STAFF,CENTERS,DRIVERS}
//   - EMERGENCY_RESPONSE.CORE.{ORS_ISOCHRONE_FOR_CENTER,ORS_OPTIMIZATION_AVOIDING}
//
// Dynamic Tables for Reachability and Dispatch are intentionally NOT created
// (Snowflake DTs cannot embed table-valued ORS subqueries). Both pages call
// ORS live via the wrapper UDFs.

import { Router } from 'express';
import { runSql } from '../lib/sql.js';
import { escapeString } from '../lib/sanitize.js';
import { log } from '../diagnostics.js';

const QUERY_TAG = `'{"origin":"sf_sit-is-fleet","name":"oss-emergency-response","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"app"}}'`;

async function setQueryTag(): Promise<void> {
  try {
    await runSql(`ALTER SESSION SET query_tag = ${QUERY_TAG}`);
  } catch {
    /* non-fatal */
  }
}

export function createEmergencyRouter(): Router {
  const router = Router();

  // -------------------------------------------------------------------------
  // Page 1 -- Hazard Operations Center
  // -------------------------------------------------------------------------
  router.get('/api/emergency/alerts', async (_req, res) => {
    try {
      await setQueryTag();
      const rows = await runSql(`
        SELECT
          alert_id, event_type, severity, urgency, certainty,
          headline, description, instruction,
          effective_time, expires_time,
          ST_ASGEOJSON(boundary) AS boundary_geojson,
          severity_rank
        FROM EMERGENCY_RESPONSE.PIPELINE.STG_NWS_ACTIVE_ALERTS
        ORDER BY severity_rank DESC, effective_time DESC
        LIMIT 200
      `);
      const alerts = rows.map((r: any) => ({
        alertId: r.ALERT_ID,
        eventType: r.EVENT_TYPE,
        severity: r.SEVERITY,
        urgency: r.URGENCY,
        certainty: r.CERTAINTY,
        headline: r.HEADLINE,
        description: r.DESCRIPTION,
        instruction: r.INSTRUCTION,
        effectiveTime: r.EFFECTIVE_TIME,
        expiresTime: r.EXPIRES_TIME,
        severityRank: Number(r.SEVERITY_RANK),
        boundaryGeoJson: r.BOUNDARY_GEOJSON ? JSON.parse(r.BOUNDARY_GEOJSON) : null,
      }));
      res.json({ alerts });
    } catch (err: any) {
      log('ERROR', 'emergency.alerts', err.message, { detail: err.stack });
      res.status(500).json({ error: err.message });
    }
  });

  // KPI cards for Page 1
  router.get('/api/emergency/kpis', async (_req, res) => {
    try {
      await setQueryTag();
      const [alerts, impacted, drivers, centers] = await Promise.all([
        runSql(`SELECT COUNT(*) AS C FROM EMERGENCY_RESPONSE.PIPELINE.STG_NWS_ACTIVE_ALERTS`),
        runSql(`SELECT COUNT(DISTINCT PARTICIPANT_ID) AS C FROM EMERGENCY_RESPONSE.PIPELINE.FACT_IMPACTED_PARTICIPANTS`),
        runSql(`SELECT COUNT(*) AS C FROM EMERGENCY_RESPONSE.CORE.DRIVERS WHERE STATUS='ON_SHIFT'`),
        runSql(`SELECT COUNT(*) AS C FROM EMERGENCY_RESPONSE.CORE.CENTERS`),
      ]);
      res.json({
        activeAlerts: Number(alerts[0]?.C ?? 0),
        impactedParticipants: Number(impacted[0]?.C ?? 0),
        driversOnShift: Number(drivers[0]?.C ?? 0),
        totalCenters: Number(centers[0]?.C ?? 0),
      });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // Sample of participants (with optional limit) for the map ScatterplotLayer
  router.get('/api/emergency/entities/participants', async (req, res) => {
    try {
      await setQueryTag();
      const limit = Math.max(1, Math.min(10000, Number(req.query.limit) || 2000));
      const rows = await runSql(`
        SELECT PARTICIPANT_ID, ST_X(HOME_LOC) AS LON, ST_Y(HOME_LOC) AS LAT,
               FRAILTY_SCORE, REQUIRES_LIFT
        FROM EMERGENCY_RESPONSE.CORE.PARTICIPANTS
        SAMPLE (${limit} ROWS)
      `);
      res.json({
        participants: rows.map((r: any) => ({
          id: r.PARTICIPANT_ID,
          loc: [Number(r.LON), Number(r.LAT)],
          frailty: Number(r.FRAILTY_SCORE),
          requiresLift: Boolean(r.REQUIRES_LIFT),
        })),
      });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  router.get('/api/emergency/entities/centers', async (_req, res) => {
    try {
      await setQueryTag();
      const rows = await runSql(`
        SELECT CENTER_ID, CENTER_NAME, ST_X(LOC) AS LON, ST_Y(LOC) AS LAT,
               CAPACITY, HAS_GENERATOR, IS_SHELTER
        FROM EMERGENCY_RESPONSE.CORE.CENTERS
      `);
      res.json({
        centers: rows.map((r: any) => ({
          id: r.CENTER_ID,
          name: r.CENTER_NAME,
          loc: [Number(r.LON), Number(r.LAT)],
          capacity: Number(r.CAPACITY),
          hasGenerator: Boolean(r.HAS_GENERATOR),
          isShelter: Boolean(r.IS_SHELTER),
        })),
      });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  router.get('/api/emergency/entities/drivers', async (_req, res) => {
    try {
      await setQueryTag();
      const rows = await runSql(`
        SELECT DRIVER_ID, FULL_NAME, STATUS, ST_X(CURRENT_LOC) AS LON, ST_Y(CURRENT_LOC) AS LAT,
               VEHICLE_TYPE, HAS_LIFT, CAPACITY
        FROM EMERGENCY_RESPONSE.CORE.DRIVERS
      `);
      res.json({
        drivers: rows.map((r: any) => ({
          id: r.DRIVER_ID,
          name: r.FULL_NAME,
          status: r.STATUS,
          loc: [Number(r.LON), Number(r.LAT)],
          vehicleType: r.VEHICLE_TYPE,
          hasLift: Boolean(r.HAS_LIFT),
          capacity: Number(r.CAPACITY),
        })),
      });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // -------------------------------------------------------------------------
  // Page 2 -- Participant Triage
  // -------------------------------------------------------------------------
  router.get('/api/emergency/impacted/:alertId', async (req, res) => {
    try {
      await setQueryTag();
      const alertId = escapeString(req.params.alertId);
      const rows = await runSql(`
        SELECT
          f.PARTICIPANT_ID,
          p.ADDRESS_LINE || ', ' || p.CITY || ', ' || p.STATE AS address,
          ST_X(f.HOME_LOC) AS lon,
          ST_Y(f.HOME_LOC) AS lat,
          f.composite_vulnerability,
          f.REQUIRES_LIFT,
          f.miles_from_alert_centroid,
          p.PRIMARY_LANGUAGE
        FROM EMERGENCY_RESPONSE.PIPELINE.FACT_IMPACTED_PARTICIPANTS f
        JOIN EMERGENCY_RESPONSE.CORE.PARTICIPANTS p USING (PARTICIPANT_ID)
        WHERE f.alert_id = '${alertId}'
        ORDER BY f.composite_vulnerability DESC, f.miles_from_alert_centroid ASC
        LIMIT 5000
      `);
      const participants = rows.map((r: any) => ({
        participantId: r.PARTICIPANT_ID,
        address: r.ADDRESS,
        loc: [Number(r.LON), Number(r.LAT)],
        compositeVulnerability: Number(r.COMPOSITE_VULNERABILITY),
        requiresLift: Boolean(r.REQUIRES_LIFT),
        milesFromAlertCentroid: Number(r.MILES_FROM_ALERT_CENTROID),
        primaryLanguage: r.PRIMARY_LANGUAGE,
      }));
      res.json({ participants });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // -------------------------------------------------------------------------
  // Page 3 -- Reachability Under Hazard (LIVE ORS isochrone)
  // -------------------------------------------------------------------------
  router.get('/api/emergency/reachability/live/:alertId', async (req, res) => {
    try {
      await setQueryTag();
      const alertId = escapeString(req.params.alertId);
      const region = await runSql(`SELECT PARAM_VALUE AS R FROM EMERGENCY_RESPONSE.CONFIG.PARAMS WHERE PARAM_NAME='REGION'`);
      const regionName = region[0]?.R || 'SanFrancisco';
      // Verify the alert exists and grab its boundary
      const alertRow = await runSql(`
        SELECT ST_ASGEOJSON(boundary) AS boundary_geojson
        FROM EMERGENCY_RESPONSE.PIPELINE.STG_NWS_ACTIVE_ALERTS WHERE alert_id='${alertId}' LIMIT 1
      `);
      if (!alertRow.length) return res.status(404).json({ error: 'alert not found' });
      const alertGeo = alertRow[0].BOUNDARY_GEOJSON ? JSON.parse(alertRow[0].BOUNDARY_GEOJSON) : null;

      // Issue isochrone calls per center (30 min + 60 min) in parallel
      const rows = await runSql(`
        SELECT CENTER_ID, CENTER_NAME, ST_X(LOC) AS LON, ST_Y(LOC) AS LAT,
               ST_ASGEOJSON(EMERGENCY_RESPONSE.CORE.ORS_ISOCHRONE_FOR_CENTER(LOC, 1800, '${regionName}')) AS ISO30,
               ST_ASGEOJSON(EMERGENCY_RESPONSE.CORE.ORS_ISOCHRONE_FOR_CENTER(LOC, 3600, '${regionName}')) AS ISO60
        FROM EMERGENCY_RESPONSE.CORE.CENTERS
      `);
      const centers = rows.map((r: any) => ({
        centerId: r.CENTER_ID,
        centerName: r.CENTER_NAME,
        loc: [Number(r.LON), Number(r.LAT)],
        iso30GeoJson: r.ISO30 ? JSON.parse(r.ISO30) : null,
        iso60GeoJson: r.ISO60 ? JSON.parse(r.ISO60) : null,
      }));
      res.json({ centers, alertBoundaryGeoJson: alertGeo });
    } catch (err: any) {
      log('ERROR', 'emergency.reachability.live', err.message, { detail: err.stack });
      res.status(500).json({ error: err.message });
    }
  });

  // -------------------------------------------------------------------------
  // Page 4 -- Driver Dispatch (LIVE ORS optimization with avoid_polygons)
  // -------------------------------------------------------------------------
  router.post('/api/emergency/dispatch', async (req, res) => {
    try {
      await setQueryTag();
      const alertId = escapeString(req.body.alertId || '');
      if (!alertId) return res.status(400).json({ error: 'alertId required' });
      const topN = Math.max(1, Math.min(100, Number(req.body.topN) || 30));

      const region = await runSql(`SELECT PARAM_VALUE AS R FROM EMERGENCY_RESPONSE.CONFIG.PARAMS WHERE PARAM_NAME='REGION'`);
      const regionName = region[0]?.R || 'SanFrancisco';

      const planRows = await runSql(`
        WITH alert AS (
          SELECT boundary FROM EMERGENCY_RESPONSE.PIPELINE.STG_NWS_ACTIVE_ALERTS WHERE alert_id='${alertId}' LIMIT 1
        ),
        top_jobs AS (
          SELECT ROW_NUMBER() OVER (ORDER BY composite_vulnerability DESC) AS rn,
                 PARTICIPANT_ID,
                 ST_X(HOME_LOC) AS lon,
                 ST_Y(HOME_LOC) AS lat,
                 composite_vulnerability AS vuln
          FROM EMERGENCY_RESPONSE.PIPELINE.FACT_IMPACTED_PARTICIPANTS
          WHERE alert_id='${alertId}'
          QUALIFY rn <= ${topN}
        ),
        jobs_arr AS (
          SELECT ARRAY_AGG(OBJECT_CONSTRUCT(
            'id',          rn,
            'description', PARTICIPANT_ID,
            'location',    ARRAY_CONSTRUCT(lon, lat),
            'priority',    LEAST(100, vuln)::INT
          )) AS arr
          FROM top_jobs
        ),
        drivers AS (
          SELECT ROW_NUMBER() OVER (ORDER BY DRIVER_ID) AS rn,
                 DRIVER_ID,
                 ST_X(CURRENT_LOC) AS lon,
                 ST_Y(CURRENT_LOC) AS lat,
                 CAPACITY
          FROM EMERGENCY_RESPONSE.CORE.DRIVERS
          WHERE STATUS='ON_SHIFT'
        ),
        vehicles_arr AS (
          SELECT ARRAY_AGG(OBJECT_CONSTRUCT(
            'id',          rn,
            'description', DRIVER_ID,
            'start',       ARRAY_CONSTRUCT(lon, lat),
            'end',         ARRAY_CONSTRUCT(lon, lat),
            'capacity',    ARRAY_CONSTRUCT(CAPACITY)
          )) AS arr
          FROM drivers
        )
        SELECT EMERGENCY_RESPONSE.CORE.ORS_OPTIMIZATION_AVOIDING(
          j.arr, v.arr, a.boundary, '${regionName}'
        ) AS plan,
        (SELECT COUNT(*) FROM top_jobs) AS jobs_count,
        (SELECT COUNT(*) FROM drivers) AS drivers_count
        FROM jobs_arr j CROSS JOIN vehicles_arr v CROSS JOIN alert a
      `);
      if (!planRows.length) return res.status(404).json({ error: 'no plan' });
      res.json({
        plan: planRows[0].PLAN,
        jobsCount: Number(planRows[0].JOBS_COUNT),
        driversCount: Number(planRows[0].DRIVERS_COUNT),
      });
    } catch (err: any) {
      log('ERROR', 'emergency.dispatch', err.message, { detail: err.stack });
      res.status(500).json({ error: err.message });
    }
  });

  // -------------------------------------------------------------------------
  // Page 5 -- Vulnerability Planning (5y FEMA history, H3-aggregated)
  // -------------------------------------------------------------------------
  router.get('/api/emergency/history', async (_req, res) => {
    try {
      await setQueryTag();
      const rows = await runSql(`
        SELECT h3_cell, incident_type, event_count, most_recent_event, unique_disasters
        FROM EMERGENCY_RESPONSE.PIPELINE.FACT_HAZARD_HISTORY_H3
        ORDER BY event_count DESC
        LIMIT 5000
      `);
      const cells = rows.map((r: any) => ({
        H3_CELL: r.H3_CELL,
        INCIDENT_TYPE: r.INCIDENT_TYPE,
        EVENT_COUNT: Number(r.EVENT_COUNT),
        MOST_RECENT_EVENT: r.MOST_RECENT_EVENT,
        UNIQUE_DISASTERS: Number(r.UNIQUE_DISASTERS),
      }));
      res.json({ cells });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // -------------------------------------------------------------------------
  // CSV export (Page 2 button)
  // -------------------------------------------------------------------------
  router.get('/api/emergency/export/:alertId.csv', async (req, res) => {
    try {
      await setQueryTag();
      const alertId = escapeString(req.params.alertId);
      const rows = await runSql(`
        SELECT
          f.PARTICIPANT_ID,
          p.ADDRESS_LINE || ', ' || p.CITY || ', ' || p.STATE || ' ' || p.ZIP AS address,
          f.composite_vulnerability,
          f.REQUIRES_LIFT,
          f.miles_from_alert_centroid,
          p.PRIMARY_LANGUAGE
        FROM EMERGENCY_RESPONSE.PIPELINE.FACT_IMPACTED_PARTICIPANTS f
        JOIN EMERGENCY_RESPONSE.CORE.PARTICIPANTS p USING (PARTICIPANT_ID)
        WHERE f.alert_id = '${alertId}'
        ORDER BY f.composite_vulnerability DESC
      `);
      const header = 'participant_id,address,composite_vulnerability,requires_lift,miles_from_alert,primary_language\n';
      const csv = header + rows.map((r: any) => [
        r.PARTICIPANT_ID,
        `"${(r.ADDRESS || '').replace(/"/g, '""')}"`,
        r.COMPOSITE_VULNERABILITY,
        r.REQUIRES_LIFT,
        r.MILES_FROM_ALERT_CENTROID,
        r.PRIMARY_LANGUAGE,
      ].join(',')).join('\n');
      res.setHeader('Content-Type', 'text/csv');
      res.setHeader('Content-Disposition', `attachment; filename="impacted_${alertId}.csv"`);
      res.send(csv);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  return router;
}

import { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import MetricCard from '../shared/MetricCard';
import DeckGL from '@deck.gl/react';
import { ScatterplotLayer, GeoJsonLayer, PathLayer } from '@deck.gl/layers';
import { BitmapLayer } from '@deck.gl/layers';
import { TileLayer } from '@deck.gl/geo-layers';
import { PathStyleExtension } from '@deck.gl/extensions';
import { useRegion } from '../hooks/useRegion';
import { useFitMap } from '../shared/useFitMap';
import RecenterButton from '../shared/RecenterButton';
import { coordsFromGeoJSON, fitBoundsToData, type LngLat } from '../shared/mapFit';
import AssignmentList from './backload-matching/AssignmentList';
import DecisionsAudit from './backload-matching/DecisionsAudit';
import StopsPanel from './backload-matching/StopsPanel';
import {
  BM_DB, BM_SCHEMA, CARTO_LIGHT, EUR_PER_EMPTY_KM, ROUTE_COLORS,
  Trailer, Volume, Offer, Assignment, Stop, SvcStatus,
  sfQuery, haversineKm, profileForVehicleType,
} from './backload-matching/helpers';

function cartoBasemap() {
  return new TileLayer({
    id: 'carto-basemap', data: CARTO_LIGHT, minZoom: 0, maxZoom: 19, tileSize: 256,
    renderSubLayers: (props: any) => {
      const { boundingBox } = props.tile;
      return new BitmapLayer(props, { data: undefined, image: props.data, bounds: [boundingBox[0][0], boundingBox[0][1], boundingBox[1][0], boundingBox[1][1]] });
    },
  });
}

export default function BackloadMatching() {
  const { regionName, center, zoom } = useRegion();
  const [trailers, setTrailers] = useState<Trailer[]>([]);
  const [internal, setInternal] = useState<Volume[]>([]);
  const [external, setExternal] = useState<Offer[]>([]);
  const [vehicleType, setVehicleType] = useState<string>('hgv');
  const [solveError, setSolveError] = useState<string | null>(null);

  const [internalPriority, setInternalPriority] = useState(100);
  const [externalPriority, setExternalPriority] = useState(10);
  const [windowToleranceHrs, setWindowToleranceHrs] = useState(4);
  const [maxEmptyKm, setMaxEmptyKm] = useState(200);
  const [forceSharedDest, setForceSharedDest] = useState(false);
  const [matchMode, setMatchMode] = useState<'single' | 'consolidate'>('single');
  const [detourSlackHrs, setDetourSlackHrs] = useState(4);
  const [maxDetourKm, setMaxDetourKm] = useState(120);
  const [sharedDestLon, setSharedDestLon] = useState<number | null>(null);
  const [sharedDestLat, setSharedDestLat] = useState<number | null>(null);
  const [sharedDestUserEdited, setSharedDestUserEdited] = useState(false);

  const [solving, setSolving] = useState(false);
  const [assignments, setAssignments] = useState<Assignment[]>([]);
  const emptyLegCacheRef = useRef<Map<string, any>>(new Map());
  const [unassigned, setUnassigned] = useState<{ id: number; reason?: string }[]>([]);
  const [selectedAssignment, setSelectedAssignment] = useState<string | null>(null);
  const [rationale, setRationale] = useState<Record<string, string>>({});
  const [rationaleLoading, setRationaleLoading] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [confirmMsg, setConfirmMsg] = useState<string | null>(null);
  const [seedHint, setSeedHint] = useState<string | null>(null);
  const [seeding, setSeeding] = useState(false);
  const [solverLog, setSolverLog] = useState<string | null>(null);

  // ORS service status + wake-up
  const requiredServices = useMemo(
    () => ['ROUTING_GATEWAY_SERVICE',
           `ORS_SERVICE_${(regionName || '').toUpperCase()}`,
           `VROOM_SERVICE_${(regionName || '').toUpperCase()}`],
    [regionName]
  );
  const [orsProfile, setOrsProfile] = useState<string>('driving-car');
  const [svcStatus, setSvcStatus] = useState<SvcStatus[]>([]);
  const [wakingUp, setWakingUp] = useState(false);

  const fetchSvcStatus = useCallback(async (): Promise<SvcStatus[]> => {
    const rows = await sfQuery(`SHOW SERVICES IN DATABASE OPENROUTESERVICE_APP`, 'OPENROUTESERVICE_APP', 'CORE');
    const wanted = new Set(requiredServices);
    return rows
      .filter((r: any) => wanted.has(r.name || r.NAME))
      .map((r: any) => ({
        name: r.name || r.NAME,
        status: r.status || r.STATUS,
        cur: Number(r.current_instances ?? r.CURRENT_INSTANCES) || 0,
        tgt: Number(r.target_instances ?? r.TARGET_INSTANCES) || 0,
      }));
  }, [requiredServices]);

  // Auto-fill shared destination from first trailer when toggle turns on,
  // unless user has explicitly edited the inputs. Re-fills on region change
  // (trailers reload) so the default always lands inside the active region.
  useEffect(() => {
    if (!forceSharedDest) return;
    if (sharedDestUserEdited) return;
    const t = trailers[0];
    if (!t) return;
    setSharedDestLon(Number(t.HOME_LON));
    setSharedDestLat(Number(t.HOME_LAT));
  }, [forceSharedDest, trailers, sharedDestUserEdited]);

  useEffect(() => {
    let active = true;
    const tick = async () => { try { const s = await fetchSvcStatus(); if (active) setSvcStatus(s); } catch {} };
    tick();
    const id = setInterval(tick, 30000);
    return () => { active = false; clearInterval(id); };
  }, [fetchSvcStatus]);


  const wakeUp = useCallback(async () => {
    setWakingUp(true);
    try {
      const initial = await fetchSvcStatus();
      setSvcStatus(initial);
      const suspended = initial.filter(s => s.status === 'SUSPENDED').map(s => s.name);
      if (suspended.length) {
        await Promise.all(suspended.map(n =>
          fetch(`/api/services/${n}/resume`, { method: 'POST' })
        ));
      }
      for (let i = 0; i < 18; i++) {
        await new Promise(r => setTimeout(r, 5000));
        const next = await fetchSvcStatus();
        setSvcStatus(next);
        if (next.every(r => r.status === 'RUNNING' && r.cur >= r.tgt)) break;
      }
    } finally {
      setWakingUp(false);
    }
  }, [fetchSvcStatus]);

  const refetch = useCallback(async () => {
    const [tRows, iRows, eRows, cRows, profRows] = await Promise.all([
      sfQuery(`SELECT * FROM ${BM_DB}.${BM_SCHEMA}.VW_TRAILERS LIMIT 100`),
      sfQuery(`SELECT ID, PICKUP_CITY, PICKUP_LON, PICKUP_LAT, DROPOFF_CITY, DROPOFF_LON, DROPOFF_LAT, PICKUP_FROM_TS, PICKUP_TO_TS, WEIGHT_KG, PRODUCT, HAZMAT FROM ${BM_DB}.${BM_SCHEMA}.VW_INTERNAL_VOLUMES LIMIT 200`),
      sfQuery(`SELECT OFFER_ID, SOURCE, PICKUP_CITY, PICKUP_COUNTRY, PICKUP_LON, PICKUP_LAT, DROPOFF_CITY, DROPOFF_COUNTRY, DROPOFF_LON, DROPOFF_LAT, PICKUP_FROM_TS, PICKUP_TO_TS, WEIGHT_KG, PRODUCT, PRICE_EUR, HAZMAT, LISTING_TEXT FROM ${BM_DB}.${BM_SCHEMA}.VW_EXTERNAL_OFFERS LIMIT 500`),
      sfQuery(`SELECT * FROM ${BM_DB}.${BM_SCHEMA}.CONFIG`),
      sfQuery(`SELECT PROFILES FROM OPENROUTESERVICE_APP.CORE.REGION_PROVISION_JOBS WHERE STATUS='COMPLETE' AND REGION='${regionName?.replace(/'/g, "''") || ''}' ORDER BY COMPLETED_AT DESC LIMIT 1`, 'OPENROUTESERVICE_APP', 'CORE'),
    ]);
    setTrailers(tRows as Trailer[]);
    setInternal(iRows as Volume[]);
    setExternal(eRows as Offer[]);
    const cfg: Record<string, any> = (cRows[0] as any) || {};
    if (cfg.VEHICLE_TYPE != null) setVehicleType(String(cfg.VEHICLE_TYPE));
    const provProfile = (profRows[0] as any)?.PROFILES;
    if (provProfile) setOrsProfile(provProfile.split(',')[0].trim());
    if (!tRows.length || !iRows.length || !eRows.length) {
      setSeedHint(`Tables are empty for region "${regionName}". Click "Generate seed data" to populate them, or run a Data Studio job for this region.`);
    } else {
      setSeedHint(null);
    }
  }, [regionName]);

  // Option B: app region picker is the source of truth.
  // On mount + on regionName change, sync BACKLOAD_MATCHING.CONFIG (REGION + VEHICLE_TYPE)
  // then refetch. VEHICLE_TYPE is resolved from DIM_FLEET so the views match the
  // active preset (e.g. ebike for San Francisco, hgv for Germany).
  useEffect(() => {
    if (!regionName) return;
    (async () => {
      try {
        const safeRegion = regionName.replace(/'/g, "''");
        const cfg = await sfQuery(`SELECT REGION, VEHICLE_TYPE FROM ${BM_DB}.${BM_SCHEMA}.CONFIG`);
        const cur = (cfg[0] as any) || {};
        const vtRows = await sfQuery(
          `SELECT VEHICLE_TYPE, COUNT(*) AS N FROM SYNTHETIC_DATASETS.UNIFIED.DIM_FLEET
           WHERE REGION = '${safeRegion}' GROUP BY 1 ORDER BY N DESC LIMIT 1`,
          'SYNTHETIC_DATASETS', 'UNIFIED',
        );
        const detectedVt = (vtRows[0] as any)?.VEHICLE_TYPE;
        const safeVt = (detectedVt && String(detectedVt).replace(/'/g, "''")) || cur.VEHICLE_TYPE || 'hgv';
        if (cur.REGION !== regionName || (detectedVt && cur.VEHICLE_TYPE !== detectedVt)) {
          await sfQuery(
            `UPDATE ${BM_DB}.${BM_SCHEMA}.CONFIG SET REGION = '${safeRegion}', VEHICLE_TYPE = '${safeVt}'`,
          );
        }
        // Mirror the same (region, vehicle_type) into ROUTE_OPTIMIZATION.CONFIG so
        // Asset Velocity views (VW_IDLE_TRAILERS, VW_LANE_DEMAND,
        // VW_TRAILER_COST_OF_IDLENESS) line up with the active preset.
        try {
          await sfQuery(
            `UPDATE FLEET_INTELLIGENCE.ROUTE_OPTIMIZATION.CONFIG SET REGION = '${safeRegion}', VEHICLE_TYPE = '${safeVt}'`,
            'FLEET_INTELLIGENCE', 'ROUTE_OPTIMIZATION',
          );
        } catch (e) {
          console.warn('[BM] ROUTE_OPTIMIZATION.CONFIG sync failed', e);
        }
      } catch (e) {
        console.warn('[BM] CONFIG sync failed', e);
      }
      await refetch();
    })();
  }, [regionName, refetch]);

  const seedData = useCallback(async () => {
    if (!regionName || seeding) return;
    setSeeding(true);
    setSeedHint('Generating seed data...');
    try {
      const r = await fetch('/api/backload/seed', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ region: regionName }),
      });
      const j = await r.json();
      if (j.status !== 'ok') throw new Error(j.error || 'seed failed');
      await refetch();
    } catch (e: any) {
      setSeedHint(`Seed failed: ${e.message?.slice(0, 200)}`);
    } finally {
      setSeeding(false);
    }
  }, [regionName, seeding, refetch]);
  const solve = useCallback(async () => {
    if (!trailers.length) return;
    setSolving(true); setAssignments([]); setUnassigned([]); setRationale({}); setConfirmMsg(null); setSolverLog(null); setSolveError(null);

    // Auto-warm: if any required ORS service is suspended/warming, resume + wait before issuing OPTIMIZATION.
    const probe = await fetchSvcStatus();
    setSvcStatus(probe);
    if (!probe.every(s => s.status === 'RUNNING' && s.cur >= s.tgt)) {
      setSolverLog('Routing services are suspended/warming. Resuming before solve...');
      await wakeUp();
    }

    const profile = orsProfile || profileForVehicleType(vehicleType);
    const firstTrailer = trailers[0];
    const fallbackLon = firstTrailer ? Number(firstTrailer.HOME_LON) : null;
    const fallbackLat = firstTrailer ? Number(firstTrailer.HOME_LAT) : null;
    const effSharedLon = sharedDestLon ?? fallbackLon;
    const effSharedLat = sharedDestLat ?? fallbackLat;
    const trailerById = new Map<number, Trailer>();
    const trailerEnd = (t: Trailer): [number, number] =>
      forceSharedDest && effSharedLon !== null && effSharedLat !== null
        ? [effSharedLon, effSharedLat]
        : [Number(t.HOME_LON), Number(t.HOME_LAT)];
    // Approx HGV avg speed for max_travel_time budget.
    const KMH_HGV = 60;
    const directKmFor = (t: Trailer) => {
      const [eLon, eLat] = trailerEnd(t);
      return haversineKm(t.DROPOFF_LON, t.DROPOFF_LAT, eLon, eLat);
    };
    const vrpVehicles = trailers.slice(0, 30).map((t, i) => {
      const id = i + 1;
      trailerById.set(id, t);
      const [eLon, eLat] = trailerEnd(t);
      const base: any = {
        id,
        profile,
        start: [Number(t.DROPOFF_LON), Number(t.DROPOFF_LAT)],
        end:   [eLon, eLat],
        capacity: [Number(t.MAX_PAYLOAD_KG) || 24000],
        skills: t.HAZMAT_CERT ? [1, 2, 3] : [1, 2],
      };
      if (matchMode === 'single') {
        const directKm = directKmFor(t);
        const directS  = (directKm / KMH_HGV) * 3600;
        const slackS   = detourSlackHrs * 3600;
        // Single backload: 1 pickup + 1 delivery = 2 task steps; bound detour;
        // high fixed cost so VROOM never adds a trailer for a tiny gain.
        base.max_tasks = 2;
        base.max_travel_time = Math.max(1800, Math.round(directS + slackS));
        base.costs = { fixed: 100000, per_hour: 3600 };
      }
      return base;
    });

    const offerById = new Map<number, { kind: 'INTERNAL' | string; row: any }>();
    let nextId = 1000;
    const vrpShipments: any[] = [];

    // Score each shipment by detour vs direct trailer->home for the
    // BEST-FITTING trailer. detourKm = idle->pickup + pickup->dropoff
    // + dropoff->home  -  direct(idle->home). Lower = better backload.
    const detourKmForBestTrailer = (lonP: number, latP: number, lonD: number, latD: number) => {
      let best = Infinity;
      for (const t of trailers) {
        const [eLon, eLat] = trailerEnd(t);
        const direct = haversineKm(t.DROPOFF_LON, t.DROPOFF_LAT, eLon, eLat);
        const tour = haversineKm(t.DROPOFF_LON, t.DROPOFF_LAT, lonP, latP)
                   + haversineKm(lonP, latP, lonD, latD)
                   + haversineKm(lonD, latD, eLon, eLat);
        const detour = tour - direct;
        if (detour < best) best = detour;
      }
      return best;
    };

    const MAX_INTERNAL = 60;
    const MAX_EXTERNAL = 30;
    const internalScored = internal.map(v => ({ v, d: detourKmForBestTrailer(Number(v.PICKUP_LON), Number(v.PICKUP_LAT), Number(v.DROPOFF_LON), Number(v.DROPOFF_LAT)) }));
    const externalScored = external.map(o => ({ o, d: detourKmForBestTrailer(Number(o.PICKUP_LON), Number(o.PICKUP_LAT), Number(o.DROPOFF_LON), Number(o.DROPOFF_LAT)) }));
    const detourCutoff = matchMode === 'single' ? maxDetourKm : Infinity;
    const internalSubset = internalScored.filter(x => x.d <= detourCutoff).sort((a, b) => a.d - b.d).slice(0, MAX_INTERNAL).map(x => x.v);
    const externalSubset = externalScored.filter(x => x.d <= detourCutoff).sort((a, b) => a.d - b.d).slice(0, MAX_EXTERNAL).map(x => x.o);
    const internalSkipped = Math.max(0, internal.length - internalSubset.length);
    const externalSkipped = Math.max(0, external.length - externalSubset.length);

    for (const v of internalSubset) {
      const id = nextId++;
      offerById.set(id, { kind: 'INTERNAL', row: v });
      vrpShipments.push({
        pickup:   { id, location: [Number(v.PICKUP_LON),  Number(v.PICKUP_LAT)],  service: 1800 },
        delivery: { id, location: [Number(v.DROPOFF_LON), Number(v.DROPOFF_LAT)], service: 600  },
        amount: [Math.min(Number(v.WEIGHT_KG), 24000)],
        skills: v.HAZMAT ? [1, 3] : [1],
        priority: internalPriority,
      });
    }
    for (const o of externalSubset) {
      const id = nextId++;
      offerById.set(id, { kind: o.SOURCE, row: o });
      vrpShipments.push({
        pickup:   { id, location: [Number(o.PICKUP_LON),  Number(o.PICKUP_LAT)],  service: 1800 },
        delivery: { id, location: [Number(o.DROPOFF_LON), Number(o.DROPOFF_LAT)], service: 600  },
        amount: [Math.min(Number(o.WEIGHT_KG), 24000)],
        skills: o.HAZMAT ? [2, 3] : [2],
        priority: externalPriority,
      });
    }

    const challenge = { vehicles: vrpVehicles, shipments: vrpShipments, options: { g: true } };
    const jsonStr = JSON.stringify(challenge).replace(/'/g, "''");
    const sql = `SELECT * FROM TABLE(OPENROUTESERVICE_APP.CORE.OPTIMIZATION(PARSE_JSON('${jsonStr}'), '${regionName}'))`;
    console.log('[BM] OPTIMIZATION challenge: vehicles=', vrpVehicles.length, 'shipments=', vrpShipments.length, 'region=', regionName);
    const rows = await sfQuery(sql, 'OPENROUTESERVICE_APP', 'CORE');

    const newAssignments: Assignment[] = [];
    const newUnassigned: { id: number; reason?: string }[] = [];
    for (const r of rows) {
      const vehId = Number(r.VEHICLE);
      if (!vehId) {
        try {
          const ua = typeof r.UNASSIGNED === 'string' ? JSON.parse(r.UNASSIGNED) : r.UNASSIGNED;
          if (Array.isArray(ua)) for (const u of ua) newUnassigned.push({ id: Number(u.id), reason: u.reason });
        } catch {}
        continue;
      }
      const t = trailerById.get(vehId);
      if (!t) continue;
      let steps: any[] = [];
      try { steps = typeof r.STEPS === 'string' ? JSON.parse(r.STEPS) : (r.STEPS || []); } catch {}
      let routeGeo: any = null;
      try { routeGeo = typeof r.GEOJSON === 'string' ? JSON.parse(r.GEOJSON) : r.GEOJSON; } catch {}
      // Handle 'pickup' and 'delivery' step types from VROOM shipments (with backward-compat 'job').
      const taskSteps = steps.filter((s: any) => s.type === 'pickup' || s.type === 'delivery' || s.type === 'job');
      if (!taskSteps.length) continue;
      const firstPick = taskSteps.find((s: any) => s.type === 'pickup' || s.type === 'job');
      if (!firstPick) continue;
      const firstId = Number(firstPick.id ?? firstPick.job);
      const ent = offerById.get(firstId);
      if (!ent) continue;
      const row: any = ent.row;
      const empty = haversineKm(t.DROPOFF_LON, t.DROPOFF_LAT, row.PICKUP_LON, row.PICKUP_LAT);
      if (empty > maxEmptyKm) continue;
      const loaded = haversineKm(row.PICKUP_LON, row.PICKUP_LAT, row.DROPOFF_LON, row.DROPOFF_LAT);

      // Build full STOPS list from VROOM step sequence: trailer start -> (pickups/deliveries in solver order) -> end (home/shared)
      const stops: Stop[] = [];
      stops.push({
        kind: 'start',
        label: 'Trailer idle location',
        city: t.DROPOFF_CITY,
        lon: Number(t.DROPOFF_LON),
        lat: Number(t.DROPOFF_LAT),
      });
      for (const ts of taskSteps) {
        const sid = Number(ts.id ?? ts.job);
        const je = offerById.get(sid);
        if (!je) continue;
        const jr: any = je.row;
        const offerId = je.kind === 'INTERNAL' ? jr.ID : jr.OFFER_ID;
        if (ts.type === 'delivery') {
          stops.push({
            kind: 'dropoff',
            label: `${je.kind} ${offerId}`,
            city: jr.DROPOFF_CITY,
            lon: Number(jr.DROPOFF_LON),
            lat: Number(jr.DROPOFF_LAT),
            jobId: sid,
            offerId,
            source: je.kind,
            product: jr.PRODUCT,
            weightKg: Number(jr.WEIGHT_KG) || undefined,
          });
        } else {
          // 'pickup' or legacy 'job'
          stops.push({
            kind: 'pickup',
            label: `${je.kind} ${offerId}`,
            city: jr.PICKUP_CITY,
            lon: Number(jr.PICKUP_LON),
            lat: Number(jr.PICKUP_LAT),
            jobId: sid,
            offerId,
            source: je.kind,
            product: jr.PRODUCT,
            weightKg: Number(jr.WEIGHT_KG) || undefined,
          });
          if (ts.type === 'job') {
            // legacy fallback: synthesize a dropoff right after pickup
            stops.push({
              kind: 'dropoff',
              label: `${je.kind} ${offerId}`,
              city: jr.DROPOFF_CITY,
              lon: Number(jr.DROPOFF_LON),
              lat: Number(jr.DROPOFF_LAT),
              jobId: sid,
              offerId,
              source: je.kind,
              product: jr.PRODUCT,
              weightKg: Number(jr.WEIGHT_KG) || undefined,
            });
          }
        }
      }
      const endLon = forceSharedDest && effSharedLon !== null ? effSharedLon : Number(t.HOME_LON);
      const endLat = forceSharedDest && effSharedLat !== null ? effSharedLat : Number(t.HOME_LAT);
      stops.push({
        kind: 'end',
        label: forceSharedDest ? 'Shared destination' : 'Home depot',
        city: forceSharedDest ? undefined : t.HOME_DEPOT,
        lon: endLon,
        lat: endLat,
      });

      const offerIdFirst = ent.kind === 'INTERNAL' ? row.ID : row.OFFER_ID;
      // Detour vs direct trailer->home: positive = extra km on top of empty trip,
      // ideally close to 0 or even negative (route goes "through" home anyway).
      const directHomeKm = haversineKm(t.DROPOFF_LON, t.DROPOFF_LAT, endLon, endLat);
      const tourKm =
        haversineKm(t.DROPOFF_LON, t.DROPOFF_LAT, row.PICKUP_LON, row.PICKUP_LAT) +
        haversineKm(row.PICKUP_LON, row.PICKUP_LAT, row.DROPOFF_LON, row.DROPOFF_LAT) +
        haversineKm(row.DROPOFF_LON, row.DROPOFF_LAT, endLon, endLat);
      const detourKm = Math.max(0, tourKm - directHomeKm);
      const savedKm  = Math.max(0, directHomeKm - detourKm);
      newAssignments.push({
        ASSIGNMENT_ID: `${t.TRAILER_ID}|${offerIdFirst}`,
        TRAILER_ID: t.TRAILER_ID,
        OFFER_ID: offerIdFirst,
        SOURCE: ent.kind,
        PICKUP_LON: row.PICKUP_LON, PICKUP_LAT: row.PICKUP_LAT,
        DROPOFF_LON: row.DROPOFF_LON, DROPOFF_LAT: row.DROPOFF_LAT,
        TRAILER_DROPOFF_LON: t.DROPOFF_LON, TRAILER_DROPOFF_LAT: t.DROPOFF_LAT,
        HOME_LON: t.HOME_LON, HOME_LAT: t.HOME_LAT,
        EMPTY_KM: empty, LOADED_KM: loaded,
        DETOUR_KM: detourKm, SAVED_KM: savedKm,
        SCORE: Number(r.DURATION) || 0,
        PRODUCT: row.PRODUCT,
        PICKUP_CITY: row.PICKUP_CITY,
        PROPOSAL_DROPOFF_CITY: row.DROPOFF_CITY,
        ROUTE_GEOJSON: routeGeo,
        STOPS: stops,
      });
    }
    setAssignments(newAssignments);
    setUnassigned(newUnassigned);
    const avgDetour = newAssignments.length
      ? Math.round(newAssignments.reduce((s, a) => s + (a.DETOUR_KM || 0), 0) / newAssignments.length)
      : 0;
    setSolverLog(`Mode=${matchMode} | Sent ${vrpVehicles.length} vehicles, ${vrpShipments.length} candidate shipments (cap: ${MAX_INTERNAL} internal + ${MAX_EXTERNAL} external by detour score; skipped ${internalSkipped} internal, ${externalSkipped} external; region=${regionName}, profile=${profile}). Received ${rows.length} rows, ${newAssignments.length} assignments, ${newUnassigned.length} unassigned. Avg detour +${avgDetour} km.`);
    if (rows.length === 0 && vrpShipments.length > 0) {
      setSolveError(
        `OPTIMIZATION returned 0 rows. Check: (1) all required ORS services RUNNING (check ORS status in the header), ` +
        `(2) region='${regionName}' covers your data bbox, ` +
        `(3) profile='${profile}' is supported by ORS_SERVICE_${(regionName || '').toUpperCase()}.`
      );
    }

    Promise.all(newAssignments.map(async (a) => {
      const key = `${a.TRAILER_ID}|${a.OFFER_ID}`;
      const cached = emptyLegCacheRef.current.get(key);
      if (cached) { a.EMPTY_GEOJSON = cached; return; }
      const dirSql = `SELECT ST_ASGEOJSON(GEOJSON)::VARCHAR AS GEOJSON FROM TABLE(OPENROUTESERVICE_APP.CORE.DIRECTIONS('${profile}', ARRAY_CONSTRUCT(${a.TRAILER_DROPOFF_LON}::FLOAT, ${a.TRAILER_DROPOFF_LAT}::FLOAT), ARRAY_CONSTRUCT(${a.PICKUP_LON}::FLOAT, ${a.PICKUP_LAT}::FLOAT), '${regionName}'))`;
      const dirRows = await sfQuery(dirSql, 'OPENROUTESERVICE_APP', 'CORE');
      try {
        const geo = dirRows[0]?.GEOJSON ? (typeof dirRows[0].GEOJSON === 'string' ? JSON.parse(dirRows[0].GEOJSON) : dirRows[0].GEOJSON) : null;
        if (geo) { emptyLegCacheRef.current.set(key, geo); a.EMPTY_GEOJSON = geo; }
      } catch (e) { console.warn('[BM] empty-leg DIRECTIONS parse failed', e); }
    })).then(() => setAssignments([...newAssignments]));

    setSolving(false);
  }, [trailers, internal, external, internalPriority, externalPriority, windowToleranceHrs, maxEmptyKm, regionName, vehicleType, orsProfile, forceSharedDest, sharedDestLon, sharedDestLat, matchMode, detourSlackHrs, maxDetourKm, fetchSvcStatus, wakeUp]);

  const askRationale = useCallback(async (a: Assignment) => {
    setRationaleLoading(true);
    const prompt = `You are a fleet dispatcher coach. In two short sentences, explain why trailer ${a.TRAILER_ID} (idle in ${trailers.find(t=>t.TRAILER_ID===a.TRAILER_ID)?.DROPOFF_CITY || ''}) is a good match for ${a.SOURCE} offer ${a.OFFER_ID} (${a.PICKUP_CITY} -> ${a.PROPOSAL_DROPOFF_CITY}, ${Math.round(a.EMPTY_KM)} km empty, ${a.PRODUCT}). Mention empty km saved and direction-to-home if relevant.`;
    const sql = `SELECT SNOWFLAKE.CORTEX.COMPLETE('claude-sonnet-4-5', '${prompt.replace(/'/g, "''")}') AS RESULT`;
    const rows = await sfQuery(sql, 'SNOWFLAKE', 'CORTEX');
    const text = (rows[0]?.RESULT || '').toString().trim();
    setRationale(prev => ({ ...prev, [a.ASSIGNMENT_ID]: text || '(no rationale returned)' }));
    setRationaleLoading(false);
  }, [trailers]);

  const confirmPlan = useCallback(async () => {
    if (!assignments.length) return;
    setConfirming(true); setConfirmMsg(null);
    await sfQuery(`CREATE SCHEMA IF NOT EXISTS ${BM_DB}.${BM_SCHEMA}`);
    await sfQuery(`CREATE TABLE IF NOT EXISTS ${BM_DB}.${BM_SCHEMA}.PROPOSAL_DECISIONS (
      DECISION_ID  VARCHAR DEFAULT UUID_STRING() PRIMARY KEY,
      TRAILER_ID   VARCHAR,
      OFFER_ID     VARCHAR,
      SOURCE       VARCHAR,
      SCORE        FLOAT,
      EMPTY_KM     FLOAT,
      DECIDED_BY   VARCHAR,
      DECIDED_AT   TIMESTAMP_NTZ DEFAULT CURRENT_TIMESTAMP(),
      RATIONALE    VARCHAR
    ) COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-backload-matching","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"app"}}'`);
    const values = assignments.map(a => {
      const r = (rationale[a.ASSIGNMENT_ID] || '').replace(/'/g, "''").slice(0, 500);
      return `('${a.TRAILER_ID}', '${a.OFFER_ID}', '${a.SOURCE}', ${a.SCORE.toFixed(2)}, ${a.EMPTY_KM.toFixed(2)}, 'demo-user', '${r}')`;
    }).join(',\n');
    const insertSql = `INSERT INTO ${BM_DB}.${BM_SCHEMA}.PROPOSAL_DECISIONS (TRAILER_ID, OFFER_ID, SOURCE, SCORE, EMPTY_KM, DECIDED_BY, RATIONALE) VALUES\n${values}`;
    await sfQuery(insertSql);
    setConfirmMsg(`Wrote ${assignments.length} decisions to ${BM_DB}.${BM_SCHEMA}.PROPOSAL_DECISIONS.`);
    setConfirming(false);
  }, [assignments, rationale]);

  const [auditRows, setAuditRows] = useState<any[]>([]);
  const loadAudit = useCallback(async () => {
    const sql = `SELECT TO_VARCHAR(DECIDED_AT, 'YYYY-MM-DD HH24:MI') AS DECIDED_AT, TRAILER_ID, OFFER_ID, SOURCE, ROUND(EMPTY_KM,1) AS EMPTY_KM, ROUND(EMPTY_KM * ${EUR_PER_EMPTY_KM}, 0) AS EUR_RECLAIMED FROM ${BM_DB}.${BM_SCHEMA}.PROPOSAL_DECISIONS ORDER BY DECIDED_AT DESC LIMIT 25`;
    const rows = await sfQuery(sql);
    setAuditRows(rows);
  }, []);
  useEffect(() => { loadAudit(); }, [loadAudit, confirmMsg]);

  const totalEmptyKm = useMemo(() => assignments.reduce((s, a) => s + a.EMPTY_KM, 0), [assignments]);
  const totalLoadedKm = useMemo(() => assignments.reduce((s, a) => s + a.LOADED_KM, 0), [assignments]);
  const internalCount = useMemo(() => assignments.filter(a => a.SOURCE === 'INTERNAL').length, [assignments]);
  const internalPct = assignments.length ? Math.round((internalCount / assignments.length) * 100) : 0;
  const trailersAssignedPct = trailers.length ? Math.round((assignments.length / Math.min(trailers.length, 30)) * 100) : 0;
  const eurReclaimed = Math.round(totalLoadedKm * 1.20);

  const basemap = useMemo(() => cartoBasemap(), []);
  const layers = useMemo(() => {
    const result: any[] = [basemap];
    if (external.length) {
      result.push(new ScatterplotLayer({
        id: 'ext-offers', data: external, getPosition: (d: Offer) => [Number(d.PICKUP_LON), Number(d.PICKUP_LAT)],
        getFillColor: [200, 200, 200, 160], getLineColor: [120, 120, 120, 220],
        stroked: true, lineWidthMinPixels: 1, getRadius: 600, radiusMinPixels: 3, radiusMaxPixels: 5, pickable: true,
      }));
    }
    if (internal.length) {
      result.push(new ScatterplotLayer({
        id: 'int-vols', data: internal, getPosition: (d: Volume) => [Number(d.PICKUP_LON), Number(d.PICKUP_LAT)],
        getFillColor: [41, 181, 232, 220], getRadius: 800, radiusMinPixels: 4, radiusMaxPixels: 6, pickable: true,
      }));
    }
    if (trailers.length) {
      result.push(new ScatterplotLayer({
        id: 'trailers', data: trailers, getPosition: (d: Trailer) => [Number(d.DROPOFF_LON), Number(d.DROPOFF_LAT)],
        getFillColor: [13, 176, 72, 240], getLineColor: [255, 255, 255, 255],
        stroked: true, lineWidthMinPixels: 1, getRadius: 1200, radiusMinPixels: 5, radiusMaxPixels: 9, pickable: true,
      }));
    }
    const hasSel = !!selectedAssignment;
    const loadedPaths = assignments
      .map((a, i) => ({ a, i }))
      .filter(({ a }) => !!a.ROUTE_GEOJSON)
      .map(({ a, i }) => ({
        idx: i,
        path: coordsFromGeoJSON(a.ROUTE_GEOJSON),
        isSel: a.ASSIGNMENT_ID === selectedAssignment,
      }));
    result.push(new PathLayer({
      id: 'loaded-routes',
      data: loadedPaths,
      getPath: (d: any) => d.path,
      getColor: (d: any) => {
        const c = ROUTE_COLORS[d.idx % ROUTE_COLORS.length];
        const a = d.isSel ? 255 : (hasSel ? 80 : 110);
        return [c[0], c[1], c[2], a];
      },
      getWidth: (d: any) => (d.isSel ? 6 : (hasSel ? 2 : 3)),
      widthUnits: 'pixels',
      widthMinPixels: 2,
      parameters: { depthTest: false },
      pickable: true,
      updateTriggers: {
        getColor: [selectedAssignment, hasSel],
        getWidth: [selectedAssignment, hasSel],
      },
    }));
    assignments.forEach((a, i) => {
      const isSel = a.ASSIGNMENT_ID === selectedAssignment;
      const emptyW = isSel ? 6 : (hasSel ? 2 : 4);
      const emptyAlpha = isSel ? 255 : (hasSel ? 140 : 255);
      result.push(new GeoJsonLayer({
        id: `empty-${i}`,
        data: (a.EMPTY_GEOJSON ? a.EMPTY_GEOJSON : { type:'Feature', geometry:{ type:'LineString', coordinates:[[a.TRAILER_DROPOFF_LON,a.TRAILER_DROPOFF_LAT],[a.PICKUP_LON,a.PICKUP_LAT]] } }) as any,
        stroked: true, getLineColor: [110, 110, 110, emptyAlpha], getDashArray: [10, 6], lineWidthMinPixels: emptyW,
        extensions: [new PathStyleExtension({ dash: true })],
        parameters: { depthTest: false },
      }));
    });
    if (selectedAssignment) {
      const a = assignments.find(x => x.ASSIGNMENT_ID === selectedAssignment);
      if (a) {
        const pickup = [{ lon: Number(a.PICKUP_LON), lat: Number(a.PICKUP_LAT) }];
        // Anchor green dropoff pin to the trailer's TRUE final endpoint (last STOPS entry),
        // not to first job's dropoff. With multi-shipment routes, the route ends at home/shared dest.
        const lastStop = (a.STOPS && a.STOPS.length) ? a.STOPS[a.STOPS.length - 1] : null;
        const endLon = lastStop ? lastStop.lon : Number(a.DROPOFF_LON);
        const endLat = lastStop ? lastStop.lat : Number(a.DROPOFF_LAT);
        const dropoff = [{ lon: endLon, lat: endLat }];
        // Pickup halo + marker (orange)
        result.push(new ScatterplotLayer({
          id: 'sel-pickup-halo', data: pickup, pickable: false,
          getPosition: (d: any) => [d.lon, d.lat],
          getFillColor: [245, 158, 11, 50], getRadius: 160,
          radiusMinPixels: 18, radiusMaxPixels: 60, stroked: false, filled: true,
          parameters: { depthTest: false },
        }));
        result.push(new ScatterplotLayer({
          id: 'sel-pickup-marker', data: pickup, pickable: false,
          getPosition: (d: any) => [d.lon, d.lat],
          getFillColor: [255, 255, 255, 230], getLineColor: [245, 158, 11, 255],
          getRadius: 80, radiusMinPixels: 8, radiusMaxPixels: 30,
          lineWidthMinPixels: 3, stroked: true, filled: true,
          parameters: { depthTest: false },
        }));
        // Dropoff halo + marker (green)
        result.push(new ScatterplotLayer({
          id: 'sel-dropoff-halo', data: dropoff, pickable: false,
          getPosition: (d: any) => [d.lon, d.lat],
          getFillColor: [13, 176, 72, 50], getRadius: 160,
          radiusMinPixels: 18, radiusMaxPixels: 60, stroked: false, filled: true,
          parameters: { depthTest: false },
        }));
        result.push(new ScatterplotLayer({
          id: 'sel-dropoff-marker', data: dropoff, pickable: false,
          getPosition: (d: any) => [d.lon, d.lat],
          getFillColor: [255, 255, 255, 230], getLineColor: [13, 176, 72, 255],
          getRadius: 80, radiusMinPixels: 8, radiusMaxPixels: 30,
          lineWidthMinPixels: 3, stroked: true, filled: true,
          parameters: { depthTest: false },
        }));
      }
    }
    return result;
  }, [basemap, external, internal, trailers, assignments, selectedAssignment]);

  const fitCoords = useMemo<LngLat[]>(() => {
    const out: LngLat[] = [];
    for (const t of trailers) {
      if (t.DROPOFF_LON != null && t.DROPOFF_LAT != null) out.push([Number(t.DROPOFF_LON), Number(t.DROPOFF_LAT)]);
    }
    for (const i of internal) {
      if (i.PICKUP_LON != null && i.PICKUP_LAT != null) out.push([Number(i.PICKUP_LON), Number(i.PICKUP_LAT)]);
      if ((i as any).DROPOFF_LON != null && (i as any).DROPOFF_LAT != null) out.push([Number((i as any).DROPOFF_LON), Number((i as any).DROPOFF_LAT)]);
    }
    for (const e of external) {
      if (e.PICKUP_LON != null && e.PICKUP_LAT != null) out.push([Number(e.PICKUP_LON), Number(e.PICKUP_LAT)]);
    }
    for (const a of assignments) {
      if (a.ROUTE_GEOJSON) out.push(...coordsFromGeoJSON(a.ROUTE_GEOJSON));
      if (a.EMPTY_GEOJSON) out.push(...coordsFromGeoJSON(a.EMPTY_GEOJSON));
    }
    return out;
  }, [trailers, internal, external, assignments]);

  const fallback = useMemo(() => ({ longitude: center.lng, latitude: center.lat, zoom, pitch: 0, bearing: 0 }), [center.lng, center.lat, zoom]);
  const { containerRef: mapContainerRef, dims: mapDims, viewState, setViewState, onViewStateChange, recenter } = useFitMap(fitCoords, { fallback, regionKey: regionName });

  useEffect(() => {
    if (!selectedAssignment || !mapDims) return;
    const a = assignments.find(x => x.ASSIGNMENT_ID === selectedAssignment);
    if (!a) return;
    const coords: LngLat[] = [
      [Number(a.TRAILER_DROPOFF_LON), Number(a.TRAILER_DROPOFF_LAT)],
      [Number(a.PICKUP_LON), Number(a.PICKUP_LAT)],
      [Number(a.DROPOFF_LON), Number(a.DROPOFF_LAT)],
      ...coordsFromGeoJSON(a.ROUTE_GEOJSON),
      ...coordsFromGeoJSON(a.EMPTY_GEOJSON),
    ];
    const fitted = fitBoundsToData({
      width: mapDims.width, height: mapDims.height,
      coords, padding: 60, maxZoom: 12, fallback: viewState,
    });
    if (fitted) setViewState({ ...viewState, ...fitted });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedAssignment, assignments, mapDims]);

  const getTooltip = useCallback(({ object }: any) => {
    if (!object) return null;
    if (object.TRAILER_ID) return { html: `<b>${object.TRAILER_ID}</b><br/>Idle in: ${object.DROPOFF_CITY}<br/>Home: ${object.HOME_DEPOT}<br/>HAZMAT: ${object.HAZMAT_CERT ? 'yes' : 'no'}`, style: { backgroundColor: '#14141f', color: '#e8e8f0', padding: '8px', borderRadius: '4px', fontSize: '12px' } };
    if (object.OFFER_ID) return { html: `<b>${object.SOURCE} ${object.OFFER_ID}</b><br/>${object.PICKUP_CITY} -> ${object.DROPOFF_CITY}<br/>${object.WEIGHT_KG} kg - ${object.PRODUCT}<br/>EUR ${object.PRICE_EUR}`, style: { backgroundColor: '#14141f', color: '#e8e8f0', padding: '8px', borderRadius: '4px', fontSize: '12px' } };
    if (object.ID) return { html: `<b>Internal ${object.ID}</b><br/>${object.PICKUP_CITY} -> ${object.DROPOFF_CITY}<br/>${object.WEIGHT_KG} kg - ${object.PRODUCT}`, style: { backgroundColor: '#14141f', color: '#e8e8f0', padding: '8px', borderRadius: '4px', fontSize: '12px' } };
    return null;
  }, []);

  const selected = assignments.find(a => a.ASSIGNMENT_ID === selectedAssignment);
  const stopsPanelRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (selected && stopsPanelRef.current) {
      stopsPanelRef.current.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  }, [selected?.ASSIGNMENT_ID]);

  return (
    <div className="panel" style={{ padding: 16 }}>
      <h2 style={{ fontSize: 20, marginBottom: 4 }}>Backload Matching Engine</h2>
      <p className="subtitle">Fleet-wide VRP solve over idle-bound trailers, internal volumes, and external freight-exchange offers.</p>

      {seedHint && (
        <div className="info-box" style={{ background: 'rgba(245,158,11,0.12)', color: '#a16207', border: '1px solid rgba(245,158,11,0.4)', padding: 8, borderRadius: 6, marginBottom: 12, fontSize: 12, display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
          <span>{seedHint}</span>
          <span style={{ display: 'flex', gap: 8 }}>
            <button
              type="button"
              disabled={seeding}
              onClick={seedData}
              style={{ padding: '4px 10px', fontSize: 12, borderRadius: 4, border: '1px solid rgba(245,158,11,0.6)', background: '#fff', color: '#a16207', cursor: seeding ? 'not-allowed' : 'pointer', whiteSpace: 'nowrap' }}
            >
              {seeding ? 'Generating...' : 'Generate seed data'}
            </button>
            <button
              type="button"
              disabled={seeding}
              onClick={() => refetch()}
              style={{ padding: '4px 10px', fontSize: 12, borderRadius: 4, border: '1px solid rgba(245,158,11,0.4)', background: 'transparent', color: '#a16207', cursor: 'pointer', whiteSpace: 'nowrap' }}
            >
              Refresh
            </button>
          </span>
        </div>
      )}

      <div className="metric-grid" style={{ marginBottom: 12 }}>
        <MetricCard label="Trailers" value={trailers.length} />
        <MetricCard label="Internal volumes" value={internal.length} />
        <MetricCard label="External offers" value={external.length} />
        <MetricCard label="% trailers assigned" value={`${trailersAssignedPct}%`} />
        <MetricCard label="% internal coverage" value={`${internalPct}%`} />
        <MetricCard label="EUR/day reclaimed" value={`EUR ${eurReclaimed.toLocaleString()}`} />
      </div>

      <div style={{ display: 'flex', gap: 12, alignItems: 'flex-end', flexWrap: 'wrap', marginBottom: 12 }}>
        <div style={{ minWidth: 220 }}>
          <label className="range-label">Match mode</label>
          <div style={{ display: 'flex', gap: 12, fontSize: 12, marginTop: 2 }}>
            <label style={{ display: 'inline-flex', alignItems: 'center', gap: 4, cursor: 'pointer' }}>
              <input type="radio" name="matchMode" checked={matchMode === 'single'} onChange={() => setMatchMode('single')} />
              Single backload (DHL)
            </label>
            <label style={{ display: 'inline-flex', alignItems: 'center', gap: 4, cursor: 'pointer' }}>
              <input type="radio" name="matchMode" checked={matchMode === 'consolidate'} onChange={() => setMatchMode('consolidate')} />
              Consolidation tour
            </label>
          </div>
        </div>
        {matchMode === 'single' && (
          <>
            <div style={{ minWidth: 180 }}>
              <label className="range-label">Detour slack: +{detourSlackHrs} h</label>
              <input type="range" min={0} max={12} value={detourSlackHrs} onChange={e => setDetourSlackHrs(Number(e.target.value))} style={{ width: '100%' }} />
            </div>
            <div style={{ minWidth: 180 }}>
              <label className="range-label">Max detour: {maxDetourKm} km</label>
              <input type="range" min={20} max={400} step={10} value={maxDetourKm} onChange={e => setMaxDetourKm(Number(e.target.value))} style={{ width: '100%' }} />
            </div>
          </>
        )}
        <div style={{ minWidth: 180 }}>
          <label className="range-label">Internal priority: {internalPriority}</label>
          <input type="range" min={1} max={200} value={internalPriority} onChange={e => setInternalPriority(Number(e.target.value))} style={{ width: '100%' }} />
        </div>
        <div style={{ minWidth: 180 }}>
          <label className="range-label">External priority: {externalPriority}</label>
          <input type="range" min={1} max={200} value={externalPriority} onChange={e => setExternalPriority(Number(e.target.value))} style={{ width: '100%' }} />
        </div>
        <div style={{ minWidth: 180 }}>
          <label className="range-label">Time-window slack: +/- {windowToleranceHrs} h</label>
          <input type="range" min={0} max={12} value={windowToleranceHrs} onChange={e => setWindowToleranceHrs(Number(e.target.value))} style={{ width: '100%' }} />
        </div>
        <div style={{ minWidth: 180 }}>
          <label className="range-label">Max empty km/leg: {maxEmptyKm}</label>
          <input type="range" min={50} max={600} step={10} value={maxEmptyKm} onChange={e => setMaxEmptyKm(Number(e.target.value))} style={{ width: '100%' }} />
        </div>
        <div style={{ minWidth: 220 }}>
          <label className="range-label" style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <input
              type="checkbox"
              checked={forceSharedDest}
              onChange={e => setForceSharedDest(e.target.checked)}
            />
            Force shared destination
          </label>
          {forceSharedDest && (
            <div style={{ display: 'flex', gap: 6, marginTop: 4 }}>
              <input
                type="number" step="0.0001"
                value={sharedDestLon ?? ''}
                onChange={e => { setSharedDestUserEdited(true); setSharedDestLon(e.target.value === '' ? null : Number(e.target.value)); }}
                placeholder="lon"
                style={{ width: '50%', fontSize: 11 }}
              />
              <input
                type="number" step="0.0001"
                value={sharedDestLat ?? ''}
                onChange={e => { setSharedDestUserEdited(true); setSharedDestLat(e.target.value === '' ? null : Number(e.target.value)); }}
                placeholder="lat"
                style={{ width: '50%', fontSize: 11 }}
              />
            </div>
          )}
        </div>
        <button className="btn-primary" onClick={solve} disabled={solving || !trailers.length} style={{ background: '#0DB048', minWidth: 140 }}>
          {solving ? 'Solving...' : 'Solve Backloads'}
        </button>
        <button className="btn-primary" onClick={confirmPlan} disabled={confirming || !assignments.length} style={{ minWidth: 140 }}>
          {confirming ? 'Saving...' : 'Confirm Plan'}
        </button>
      </div>

      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 16, alignItems: 'center', marginBottom: 12, padding: '8px 12px', border: '1px solid var(--border)', borderRadius: 6, fontSize: 11, color: 'var(--text-secondary)', background: 'rgba(0,0,0,0.02)' }}>
        <b style={{ color: 'var(--text-primary)' }}>Legend</b>
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
          <span style={{ width: 10, height: 10, borderRadius: '50%', background: 'rgb(200,200,200)', border: '1px solid rgb(120,120,120)', display: 'inline-block' }} />
          External offer (freight exchange)
        </span>
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
          <span style={{ width: 10, height: 10, borderRadius: '50%', background: 'rgb(41,181,232)', display: 'inline-block' }} />
          Internal volume
        </span>
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
          <span style={{ width: 10, height: 10, borderRadius: '50%', background: 'rgb(13,176,72)', border: '1px solid #fff', boxShadow: '0 0 0 1px rgba(0,0,0,0.15)', display: 'inline-block' }} />
          Idle trailer
        </span>
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
          <span style={{ width: 12, height: 12, borderRadius: '50%', border: '2px solid rgb(245,158,11)', display: 'inline-block' }} />
          Selected trailer pickup
        </span>
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
          <span style={{ display: 'inline-flex', gap: 1 }}>
            {ROUTE_COLORS.slice(0, 4).map((rc, i) => (
              <span key={i} style={{ width: 6, height: 3, background: `rgb(${rc.join(',')})`, display: 'inline-block' }} />
            ))}
          </span>
          Loaded leg (per-assignment colour)
        </span>
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
          <span style={{ width: 24, height: 0, borderTop: '3px dashed rgb(110,110,110)', display: 'inline-block' }} />
          Empty leg (deadhead to pickup)
        </span>
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
          <span style={{ fontSize: 10, padding: '1px 6px', borderRadius: 4, background: 'rgba(41,181,232,0.18)', color: 'var(--text-primary)' }}>INTERNAL</span>
          own volume (assignment list)
        </span>
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
          <span style={{ fontSize: 10, padding: '1px 6px', borderRadius: 4, background: 'rgba(200,200,200,0.4)', color: 'var(--text-primary)' }}>EXTERNAL</span>
          freight-exchange offer (assignment list)
        </span>
      </div>

      {confirmMsg && (
        <div className="info-box success" style={{ marginBottom: 12 }}>{confirmMsg}</div>
      )}
      {solverLog && (
        <div style={{ marginBottom: 12, fontSize: 11, fontFamily: 'monospace', padding: '6px 10px', background: 'rgba(0,0,0,0.04)', borderRadius: 4, color: 'var(--text-secondary)' }}>
          {solverLog}
        </div>
      )}
      {solveError && (
        <div style={{ marginBottom: 12, fontSize: 12, padding: '8px 12px', background: 'rgba(239,68,68,0.10)', border: '1px solid rgba(239,68,68,0.45)', borderRadius: 4, color: '#b91c1c' }}>
          <b>Solve returned no assignments.</b> {solveError}
        </div>
      )}

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 360px', gap: 12 }}>
        <div ref={mapContainerRef} style={{ height: 560, borderRadius: 8, border: '1px solid var(--border)', overflow: 'hidden', position: 'relative', background: '#e8e8e8' }}>
          {solving && (
            <div style={{ position: 'absolute', inset: 0, background: 'rgba(0,0,0,0.45)', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#fff', zIndex: 10, fontSize: 14 }}>
              Calling OPTIMIZATION...
            </div>
          )}
          {mapDims && (
            <DeckGL
              width={mapDims.width} height={mapDims.height}
              viewState={viewState}
              onViewStateChange={onViewStateChange}
              controller={true} layers={layers} getTooltip={getTooltip}
              style={{ position: 'absolute', top: '0', left: '0', width: `${mapDims.width}px`, height: `${mapDims.height}px` }}
            />
          )}
          <RecenterButton onClick={recenter} disabled={!fitCoords.length} />
          {selected && (
            <button
              type="button"
              onClick={() => stopsPanelRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' })}
              style={{ position: 'absolute', top: 12, right: 56, zIndex: 5, padding: '6px 10px', fontSize: 12, borderRadius: 4, border: '1px solid var(--border)', background: 'rgba(255,255,255,0.92)', color: 'var(--text-primary)', cursor: 'pointer', boxShadow: '0 1px 3px rgba(0,0,0,0.12)' }}
            >
              Stops ↓
            </button>
          )}
        </div>

        <AssignmentList
          assignments={assignments}
          unassigned={unassigned}
          selectedAssignment={selectedAssignment}
          onSelect={setSelectedAssignment}
          rationale={rationale}
          rationaleLoading={rationaleLoading}
          onAskRationale={askRationale}
        />
      </div>

      {selected && (
        <div style={{ marginTop: 12, fontSize: 11, color: 'var(--text-secondary)' }}>
          Selected trailer: <b>{selected.TRAILER_ID}</b> - duration {selected.SCORE.toFixed(0)}s - empty {Math.round(selected.EMPTY_KM)} km
        </div>
      )}

      <div ref={stopsPanelRef}>
        <StopsPanel assignment={selected || null} />
      </div>

      <DecisionsAudit rows={auditRows} onRefresh={loadAudit} />
    </div>
  );
}

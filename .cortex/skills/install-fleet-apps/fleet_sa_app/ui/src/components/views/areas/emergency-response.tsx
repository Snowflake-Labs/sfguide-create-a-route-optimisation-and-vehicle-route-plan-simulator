'use client';

// Tier-3 showcase: region-generic Emergency Response evacuation wizard.
//
// Runs for WHATEVER region/dataset is active (no CA/CO/PA lock). Data comes from
// the neutral FLEET_APP.EMERGENCY_RESPONSE contract (county FEMA hazard +
// Overture health-anchor care centers, produced by Data Studio) and the
// evac_seed / evac_solve User verbs. US-only (FEMA); when the active region has
// no hazard/anchor data the wizard shows an actionable empty state.
//
// Steps: 1) county risk choropleth  2) seed participants (isochrone union)
//        3) configure vans  4) solve the capacitated multi-depot evacuation VRP.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { GeoJsonLayer, ScatterplotLayer } from '@deck.gl/layers';
import type { Layer } from '@deck.gl/core';
import MapView from './map-view';
import { useAppStore } from '@/lib/store';
import type { LngLat } from '@/lib/map/map-fit';
import type { ViewProps } from '@/lib/types';

type Hazard = 'WILDFIRE' | 'FLOOD';
interface County { county: string; geojson: string; wildfire_level: number; flood_level: number; }
interface CareCenter { center_id: string; center_name: string; lon: number; lat: number; }
interface Participant {
  pid: string; lon: number; lat: number; address: string | null; county: string | null;
  wfLvl: number; wfLbl: string; flLvl: number; flLbl: string;
}

// Risk ramp 0..5 -> grey, green, lime, yellow, orange, red.
const RISK_RGB: [number, number, number][] = [
  [148, 163, 184], [34, 197, 94], [132, 204, 22], [234, 179, 8], [249, 115, 22], [220, 38, 38],
];
const RISK_LABELS = ['No Rating', 'Very Low', 'Relatively Low', 'Relatively Moderate', 'Relatively High', 'Very High'];
const riskColor = (lvl: number): [number, number, number] => RISK_RGB[Math.max(0, Math.min(5, Math.round(lvl || 0)))];

// Per-physical-van color ramp for the trips list + selected route stops.
const ROUTE_PALETTE: [number, number, number][] = [
  [37, 99, 235], [219, 39, 119], [16, 185, 129], [202, 138, 4],
  [124, 58, 237], [13, 148, 136], [234, 88, 12], [99, 102, 241],
];

// Hard ceiling on virtual trips per van when auto-scaling capacity.
const CEIL_TRIPS = 12;

interface PlanStop { seq: number; lon: number; lat: number; pid: string; }
interface PlanTrip {
  tripKey: string; physIndex: number; vehicleLabel: string; vehicleId: number;
  tripNumber: number; stops: PlanStop[]; load: number; capacity: number; durationSec: number;
}
interface PlanStats { evacuees: number; assigned: number; trips: number; totalMin: number; overflow: number; autoTrips: number; }
interface VehicleMeta { physIndex: number; vehicleLabel: string; tripSlot: number; capacity: number; }

// Parse native VROOM routes[] into grouped, renumbered trips. Job-step ids map
// back to participant pids via jobParticipant; stop coords come from our own
// evacuee list so we never depend on VROOM echoing step locations.
function parseRoutes(
  routes: any[],
  evacuees: Participant[],
  vehicleMeta: Record<number, VehicleMeta>,
  jobParticipant: Record<number, string>,
): { trips: PlanTrip[]; assigned: number } {
  const byPid: Record<string, Participant> = {};
  for (const p of evacuees) byPid[p.pid] = p;
  type Raw = { meta: VehicleMeta; vehicleId: number; stops: PlanStop[]; durationSec: number };
  const raws: Raw[] = [];
  const assigned = new Set<number>();
  for (const route of routes || []) {
    const vid = Number(route?.vehicle);
    const meta = vehicleMeta[vid];
    if (!meta) continue;
    const steps: any[] = Array.isArray(route?.steps) ? route.steps : [];
    const jobSteps = steps.filter((s) => s?.type === 'job' && s?.id != null);
    if (!jobSteps.length) continue;
    const stops: PlanStop[] = [];
    jobSteps.forEach((s: any, i: number) => {
      const jobId = Number(s.id);
      assigned.add(jobId);
      const pid = jobParticipant[jobId];
      const p = pid ? byPid[pid] : undefined;
      if (p) stops.push({ seq: i + 1, lon: p.lon, lat: p.lat, pid: p.pid });
    });
    raws.push({ meta, vehicleId: vid, stops, durationSec: Number(route?.duration) || 0 });
  }
  const groups: Record<number, Raw[]> = {};
  for (const r of raws) (groups[r.meta.physIndex] ||= []).push(r);
  const trips: PlanTrip[] = [];
  for (const physIndex of Object.keys(groups).map(Number).sort((a, b) => a - b)) {
    const g = groups[physIndex].sort((a, b) => a.meta.tripSlot - b.meta.tripSlot);
    g.forEach((r, i) => {
      trips.push({
        tripKey: `${physIndex}:${i + 1}`, physIndex, vehicleLabel: r.meta.vehicleLabel, vehicleId: r.vehicleId,
        tripNumber: i + 1, stops: r.stops, load: r.stops.length, capacity: r.meta.capacity, durationSec: r.durationSec,
      });
    });
  }
  return { trips, assigned: assigned.size };
}

// Parse a fetch Response defensively. The SPCS ingress can return a plain-text
// "upstream request timeout" (504) for a long routing call instead of JSON;
// res.json() would then throw "Unexpected token 'u'…". Read text first and give
// a friendly, actionable message.
async function parseJsonOrThrow(res: Response): Promise<Record<string, unknown>> {
  const text = await res.text();
  let body: Record<string, unknown> | null = null;
  try { body = text ? (JSON.parse(text) as Record<string, unknown>) : null; } catch { body = null; }
  if (body === null) {
    if (res.status === 504 || /upstream|timeout|gateway/i.test(text)) {
      throw new Error('Routing engine is busy (timed out). Wait a few seconds and try again, or reduce the travel time.');
    }
    throw new Error(`HTTP ${res.status}: ${text.slice(0, 160)}`);
  }
  if (!res.ok) throw new Error(String(body.error || `HTTP ${res.status}`));
  return body;
}

async function apiQuery(sql: string, params?: Record<string, string | null>): Promise<Record<string, unknown>[]> {
  const res = await fetch('/api/query', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sql, params }),
  });
  const body = await parseJsonOrThrow(res);
  return (body.rows as Record<string, unknown>[]) || [];
}

async function apiTool(verb: string, args: unknown[]): Promise<Record<string, unknown>> {
  const res = await fetch('/api/tool', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ verb, args }),
  });
  const body = await parseJsonOrThrow(res);
  // The synapse envelope nests the proc output under result.result; unwrap one
  // level when present so callers read { status, participants, ... } directly.
  const r = body.result as Record<string, unknown> | null;
  if (r && typeof r === 'object' && 'result' in r && r.result && typeof r.result === 'object') {
    return r.result as Record<string, unknown>;
  }
  return r || {};
}

const ER = 'FLEET_APP.EMERGENCY_RESPONSE';

export function EmergencyResponseView({ onStateChange }: Partial<ViewProps> = {}) {
  const region = useAppStore((s) => s.context['region']) as string | undefined;

  const [avail, setAvail] = useState<'checking' | 'ready' | 'unavailable'>('checking');
  const [step, setStep] = useState(1);
  const [hazard, setHazard] = useState<Hazard>('WILDFIRE');
  const [counties, setCounties] = useState<County[]>([]);
  const [centers, setCenters] = useState<CareCenter[]>([]);
  const [minutes, setMinutes] = useState(15);
  const [targetCount, setTargetCount] = useState(60);
  const [participants, setParticipants] = useState<Participant[]>([]);
  const [unionGeo, setUnionGeo] = useState<GeoJSON.Geometry | null>(null);
  const [numVehicles, setNumVehicles] = useState(4);
  const [capacity, setCapacity] = useState(6);
  const [maxTrips, setMaxTrips] = useState(3);
  const [evacLevel, setEvacLevel] = useState(3);
  const [routeGeo, setRouteGeo] = useState<GeoJSON.FeatureCollection | null>(null);
  const [trips, setTrips] = useState<PlanTrip[]>([]);
  const [planStats, setPlanStats] = useState<PlanStats | null>(null);
  const [selectedTripKey, setSelectedTripKey] = useState<string | null>(null);
  const [unassignedPids, setUnassignedPids] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Every loaded/seeded care center is a depot (no cap); the "Vans" input is the
  // van count PER center, so total fleet = centers x vans.
  const depotCount = centers.length;

  // Publish a compact, scalar-only summary of the on-screen state into panel
  // context so the left-side agent can answer "analyse results in dashboard"
  // directly from injected context (no tool call, no misroute). Geometry and
  // per-participant arrays are intentionally excluded to keep the context line
  // small. onStateChange is held in a ref (its identity changes every render),
  // and we only publish when the serialized summary actually changes, so this
  // never loops with the store write-back.
  const summary = useMemo(() => ({
    view: 'emergency_response',
    region: region ?? null,
    hazard,
    isochrone_minutes: minutes,
    participants_seeded: participants.length,
    risk_threshold: `${RISK_LABELS[evacLevel]} (level ${evacLevel})`,
    vans_per_center: numVehicles,
    depot_count: depotCount,
    total_vans: depotCount * numVehicles,
    capacity_per_van: capacity,
    max_trips_per_van: maxTrips,
    evacuees: planStats?.evacuees ?? null,
    assigned: planStats?.assigned ?? null,
    trips: planStats?.trips ?? null,
    total_drive_min: planStats?.totalMin ?? null,
    overflow: planStats?.overflow ?? null,
    step,
    availability: avail,
  }), [region, hazard, minutes, participants.length, evacLevel, numVehicles, capacity, maxTrips, planStats, step, avail, depotCount]);

  const onStateChangeRef = useRef(onStateChange);
  onStateChangeRef.current = onStateChange;
  const lastSentRef = useRef<string>('');
  useEffect(() => {
    const json = JSON.stringify(summary);
    if (json === lastSentRef.current) return;
    lastSentRef.current = json;
    onStateChangeRef.current?.(summary);
  }, [summary]);

  // Availability + Step 1 data load whenever the active region changes.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      setAvail('checking'); setError(null);
      setStep(1); setParticipants([]); setUnionGeo(null); setRouteGeo(null);
      setTrips([]); setPlanStats(null); setSelectedTripKey(null); setUnassignedPids([]);
      try {
        const rgn = region || null;
        const hz = await apiQuery(
          `SELECT COUNTY, GEOJSON, WILDFIRE_LEVEL, FLOOD_LEVEL FROM ${ER}.VW_HAZARD_ZONES`
          + (rgn ? ` WHERE REGION = :region` : ``), rgn ? { region: rgn } : undefined);
        const cc = await apiQuery(
          `SELECT CENTER_ID, CENTER_NAME, LON, LAT FROM ${ER}.VW_CARE_CENTERS`
          + (rgn ? ` WHERE REGION = :region` : ``) + ` LIMIT 200`, rgn ? { region: rgn } : undefined);
        if (cancelled) return;
        const counties2 = hz.map((r) => ({
          county: String(r.county ?? ''), geojson: String(r.geojson ?? ''),
          wildfire_level: Number(r.wildfire_level ?? 0), flood_level: Number(r.flood_level ?? 0),
        })).filter((c) => c.geojson);
        const centers2 = cc.map((r) => ({
          center_id: String(r.center_id ?? ''), center_name: String(r.center_name ?? ''),
          lon: Number(r.lon), lat: Number(r.lat),
        })).filter((c) => Number.isFinite(c.lon) && Number.isFinite(c.lat));
        setCounties(counties2); setCenters(centers2);
        setAvail(counties2.length > 0 && centers2.length > 0 ? 'ready' : 'unavailable');
      } catch (e) {
        if (!cancelled) { setError(e instanceof Error ? e.message : 'load failed'); setAvail('unavailable'); }
      }
    })();
    return () => { cancelled = true; };
  }, [region]);

  const seed = useCallback(async () => {
    setBusy(true); setError(null); setRouteGeo(null);
    setTrips([]); setPlanStats(null); setSelectedTripKey(null); setUnassignedPids([]);
    try {
      const r = await apiTool('evac_seed', [region ?? null, hazard, minutes, targetCount]);
      if (r.status !== 'SUCCESS') throw new Error(String(r.error || 'Seeding failed'));
      setUnionGeo((r.union_geojson as GeoJSON.Geometry) ?? null);
      // Proc returns snake_case + both hazard levels per participant so dots can
      // recolor to match the hexagon layer when the hazard toggle flips.
      const rawParts = (r.participants as Record<string, unknown>[]) ?? [];
      setParticipants(rawParts.map((p) => ({
        pid: String(p.pid ?? ''), lon: Number(p.lon), lat: Number(p.lat),
        address: p.address != null ? String(p.address) : null,
        county: p.county != null ? String(p.county) : null,
        wfLvl: Number(p.wf_lvl ?? 0), wfLbl: String(p.wf_lbl ?? 'No Rating'),
        flLvl: Number(p.fl_lvl ?? 0), flLbl: String(p.fl_lbl ?? 'No Rating'),
      })));
      setStep(3);
    } catch (e) { setError(e instanceof Error ? e.message : 'Seeding failed'); }
    finally { setBusy(false); }
  }, [region, hazard, minutes, targetCount]);

  const solve = useCallback(async () => {
    // Evacuate only participants at/above the selected risk level for the active
    // hazard. Levels come from the seed, so the threshold can change without
    // re-seeding.
    const evacuees = participants.filter(
      (p) => (hazard === 'WILDFIRE' ? p.wfLvl : p.flLvl) >= evacLevel,
    );
    if (!evacuees.length) {
      setError(`No participants at or above ${RISK_LABELS[evacLevel]} (level ${evacLevel}) for this hazard. Lower the threshold or re-seed.`);
      return;
    }
    setBusy(true); setError(null);
    setTrips([]); setPlanStats(null); setSelectedTripKey(null); setUnassignedPids([]);
    try {
      // Multi-depot, multi-trip: EVERY seeded/loaded care center is a depot, each
      // holding `numVehicles` vans (no cap). Expand each van into virtual vehicles
      // (one per trip). Auto-raise the trip count so total seats
      // (centers*vans*capacity*trips) cover every evacuee, capped at CEIL_TRIPS.
      const depots = centers;
      const vansPerCenter = Math.max(1, numVehicles);
      const cap = Math.max(1, capacity);
      const totalVans = Math.max(1, depots.length * vansPerCenter);
      const neededTrips = Math.ceil(evacuees.length / (totalVans * cap));
      const effTrips = Math.min(CEIL_TRIPS, Math.max(Math.max(1, maxTrips), neededTrips));
      const vehicles: unknown[] = [];
      const vehicleMeta: Record<number, VehicleMeta> = {};
      let vid = 1;
      let physIndex = 0;
      for (const d of depots) {
        for (let k = 0; k < vansPerCenter; k++) {
          const label = `${d.center_name} - Van ${k + 1}`;
          for (let t = 0; t < effTrips; t++) {
            vehicles.push({ id: vid, start: [d.lon, d.lat], end: [d.lon, d.lat], profile: 'driving-car', capacity: [cap] });
            vehicleMeta[vid] = { physIndex, vehicleLabel: label, tripSlot: t, capacity: cap };
            vid++;
          }
          physIndex++;
        }
      }
      const jobParticipant: Record<number, string> = {};
      const jobs = evacuees.map((p, i) => {
        jobParticipant[i + 1] = p.pid;
        return { id: i + 1, location: [p.lon, p.lat], pickup: [1], description: p.pid };
      });
      const challenge = JSON.stringify({ vehicles, jobs });
      const r = await apiTool('evac_solve', [challenge, region ?? null]);
      if (r.status !== 'SUCCESS') throw new Error(String(r.error || 'Solve failed'));
      const geo = r.geometry as GeoJSON.FeatureCollection | GeoJSON.Geometry | null;
      const fc: GeoJSON.FeatureCollection = geo && (geo as GeoJSON.FeatureCollection).type === 'FeatureCollection'
        ? (geo as GeoJSON.FeatureCollection)
        : { type: 'FeatureCollection', features: geo ? [{ type: 'Feature', geometry: geo as GeoJSON.Geometry, properties: {} }] : [] };
      setRouteGeo(fc);

      // Build trips + coverage stats from the routes VROOM actually returned.
      const routes = (r.routes as any[]) ?? [];
      const { trips: parsed, assigned } = parseRoutes(routes, evacuees, vehicleMeta, jobParticipant);
      setTrips(parsed);
      const assignedPids = new Set(parsed.flatMap((t) => t.stops.map((s) => s.pid)));
      setUnassignedPids(evacuees.filter((p) => !assignedPids.has(p.pid)).map((p) => p.pid));
      const totalMin = Math.round(parsed.reduce((a, t) => a + t.durationSec, 0) / 60);
      setPlanStats({
        evacuees: evacuees.length, assigned, trips: parsed.length, totalMin,
        overflow: Math.max(0, evacuees.length - assigned),
        autoTrips: effTrips > Math.max(1, maxTrips) ? effTrips : 0,
      });
      setStep(4);
    } catch (e) { setError(e instanceof Error ? e.message : 'Solve failed'); }
    finally { setBusy(false); }
  }, [centers, numVehicles, maxTrips, capacity, participants, hazard, evacLevel, region]);

  // deck.gl layers per current state.
  const layers = useMemo<Layer[]>(() => {
    const out: Layer[] = [];
    if (counties.length) {
      const features = counties.map((c) => {
        let g: GeoJSON.Geometry | null = null;
        try { g = JSON.parse(c.geojson); } catch { g = null; }
        const lvl = hazard === 'WILDFIRE' ? c.wildfire_level : c.flood_level;
        return g ? { type: 'Feature' as const, geometry: g, properties: { county: c.county, lvl } } : null;
      }).filter(Boolean) as GeoJSON.Feature[];
      out.push(new GeoJsonLayer({
        id: 'counties', data: { type: 'FeatureCollection', features },
        stroked: false, filled: true, getFillColor: (f: any) => [...riskColor(f.properties.lvl), 110] as any,
        pickable: true,
      }));
    }
    if (unionGeo) {
      out.push(new GeoJsonLayer({
        id: 'iso-union', data: { type: 'Feature', geometry: unionGeo, properties: {} } as any,
        stroked: true, filled: true, getFillColor: [37, 99, 235, 16],
        getLineColor: [37, 99, 235, 220], lineWidthUnits: 'pixels', lineWidthMinPixels: 1, getLineWidth: 1.5,
      }));
    }
    if (centers.length) {
      out.push(new ScatterplotLayer({
        id: 'centers', data: centers, getPosition: (d: CareCenter) => [d.lon, d.lat],
        getFillColor: [17, 24, 39], getRadius: 60, radiusMinPixels: 5, radiusMaxPixels: 12, pickable: true,
      }));
    }
    if (participants.length) {
      out.push(new ScatterplotLayer({
        id: 'participants', data: participants, getPosition: (d: Participant) => [d.lon, d.lat],
        // Below-threshold participants are not evacuated -> render faded so the
        // active evacuation set is visually obvious.
        getFillColor: (d: Participant) => {
          const lvl = hazard === 'WILDFIRE' ? d.wfLvl : d.flLvl;
          return [...riskColor(lvl), lvl >= evacLevel ? 255 : 140] as any;
        },
        stroked: true, getLineColor: [15, 23, 42, 230], lineWidthUnits: 'pixels', lineWidthMinPixels: 1, getLineWidth: 1,
        getRadius: 45, radiusMinPixels: 5, radiusMaxPixels: 10, pickable: true,
        updateTriggers: { getFillColor: [hazard, evacLevel] },
      }));
    }
    if (routeGeo) {
      const selTrip = selectedTripKey ? trips.find((x) => x.tripKey === selectedTripKey) : undefined;
      const selVeh = selTrip?.vehicleId ?? null;
      // Color each route by its van so map lines match the trips-list swatches.
      const vehColor: Record<number, [number, number, number]> = {};
      for (const t of trips) vehColor[t.vehicleId] = ROUTE_PALETTE[t.physIndex % ROUTE_PALETTE.length];
      out.push(new GeoJsonLayer({
        id: 'routes', data: routeGeo, stroked: true, filled: false, lineWidthUnits: 'pixels',
        getLineColor: (f: any) => {
          const c = vehColor[f?.properties?.vehicle] ?? [37, 99, 235];
          return [...c, 235] as any;
        },
        getLineWidth: (f: any) => (selVeh != null && f?.properties?.vehicle === selVeh ? 6 : 3),
        updateTriggers: { getLineColor: [trips], getLineWidth: [selVeh] },
      }));
    }
    // Participants VROOM could not seat (above threshold but unassigned): ringed
    // dots so any remaining coverage gap is unmistakable.
    if (unassignedPids.length) {
      const set = new Set(unassignedPids);
      const pts = participants.filter((p) => set.has(p.pid));
      out.push(new ScatterplotLayer({
        id: 'unassigned', data: pts, getPosition: (d: Participant) => [d.lon, d.lat],
        getFillColor: [255, 255, 255, 230], getLineColor: [220, 38, 38], stroked: true, filled: true,
        lineWidthMinPixels: 2, getRadius: 45, radiusMinPixels: 5, radiusMaxPixels: 9, pickable: true,
      }));
    }
    // Selected trip: highlight its pickup stops in the van's palette color.
    if (selectedTripKey) {
      const t = trips.find((x) => x.tripKey === selectedTripKey);
      if (t) {
        const c = ROUTE_PALETTE[t.physIndex % ROUTE_PALETTE.length];
        out.push(new ScatterplotLayer({
          id: 'selected-stops', data: t.stops, getPosition: (d: PlanStop) => [d.lon, d.lat],
          getFillColor: [...c, 255] as any, getLineColor: [255, 255, 255, 255], stroked: true, filled: true,
          lineWidthMinPixels: 2, getRadius: 55, radiusMinPixels: 6, radiusMaxPixels: 11, pickable: true,
        }));
      }
    }
    return out;
  }, [counties, hazard, evacLevel, unionGeo, centers, participants, routeGeo, unassignedPids, selectedTripKey, trips]);

  const fitCoords = useMemo<LngLat[]>(() => {
    const c: LngLat[] = [];
    for (const p of participants) c.push([p.lon, p.lat]);
    if (!participants.length) for (const ce of centers) c.push([ce.lon, ce.lat]);
    return c;
  }, [participants, centers]);

  const labelStyle = { fontSize: '12px', fontWeight: 600, color: 'var(--text-secondary, #6b7280)', textTransform: 'uppercase' as const, marginBottom: '4px', display: 'block' };
  const inputStyle = { width: '100%', padding: '8px 10px', fontSize: '13px', borderRadius: '6px', border: '1px solid var(--border-default, #e5e7eb)', backgroundColor: 'var(--surface-primary, #fff)', color: 'var(--text-primary, #111827)' };
  const btn = (enabled: boolean) => ({ padding: '8px 16px', fontSize: '13px', fontWeight: 600, borderRadius: '6px', border: 'none', cursor: enabled ? 'pointer' : 'not-allowed', backgroundColor: 'var(--surface-accent-strong, #2563eb)', color: '#fff', opacity: enabled ? 1 : 0.6 });

  if (avail === 'unavailable') {
    return (
      <div style={{ padding: '24px', maxWidth: 640 }}>
        <h2 style={{ fontSize: '16px', fontWeight: 700, margin: '0 0 8px' }}>Emergency Response</h2>
        <div style={{ padding: '16px', borderRadius: '8px', backgroundColor: 'var(--surface-warning, #fffbeb)', border: '1px solid var(--border-warning, #fde68a)', fontSize: '13px', color: 'var(--text-primary, #111827)' }}>
          <p style={{ margin: '0 0 8px', fontWeight: 600 }}>No Emergency Response data for {region || 'the active region'}.</p>
          <p style={{ margin: 0 }}>
            This use case needs county hazard + health-anchor data. In the <strong>Data Studio</strong> (Admin app),
            run a generation for this region with <strong>Hazard</strong> and <strong>Anchors</strong> enabled, then re-open this page.
            Hazard data is US-only (FEMA National Risk Index).
          </p>
          {error && <p style={{ margin: '8px 0 0', color: 'var(--text-error, #dc2626)' }}>{error}</p>}
        </div>
      </div>
    );
  }

  return (
    <div style={{ display: 'grid', gridTemplateColumns: '340px 1fr', height: '100%', overflow: 'hidden' }}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: '14px', padding: '16px', overflow: 'auto', borderRight: '1px solid var(--border-default, #e5e7eb)' }}>
        <div>
          <h2 style={{ fontSize: '16px', fontWeight: 700, margin: '0 0 4px' }}>Emergency Response</h2>
          <p style={{ fontSize: '12px', color: 'var(--text-secondary, #6b7280)', margin: 0 }}>
            Evacuation planning for <strong>{region || 'active region'}</strong> · {counties.length} counties · {centers.length} care centers
          </p>
        </div>

        <div>
          <label style={labelStyle}>1 · Hazard</label>
          <select style={inputStyle} value={hazard} onChange={(e) => setHazard(e.target.value as Hazard)}>
            <option value="WILDFIRE">Wildfire</option>
            <option value="FLOOD">Flood</option>
          </select>
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '10px' }}>
          <div>
            <label style={labelStyle}>2 · Isochrone min</label>
            <input type="number" min={1} max={60} style={inputStyle} value={minutes} onChange={(e) => setMinutes(Number(e.target.value))} />
          </div>
          <div>
            <label style={labelStyle}>Participants</label>
            <input type="number" min={1} max={300} style={inputStyle} value={targetCount} onChange={(e) => setTargetCount(Number(e.target.value))} />
          </div>
        </div>
        <button style={btn(!busy)} disabled={busy} onClick={seed}>{busy ? 'Seeding…' : 'Seed participants'}</button>

        {participants.length > 0 && (
          <>
            <div style={{ fontSize: '12px', color: 'var(--text-secondary, #6b7280)' }}>{participants.length} routable participants seeded.</div>
            <div>
              <label style={labelStyle}>3 · Evacuate risk ≥</label>
              <select style={inputStyle} value={evacLevel} onChange={(e) => setEvacLevel(Number(e.target.value))}>
                {[1, 2, 3, 4, 5].map((lv) => (
                  <option key={lv} value={lv}>{RISK_LABELS[lv]} & above (level {lv})</option>
                ))}
              </select>
              <div style={{ fontSize: '11px', color: 'var(--text-secondary, #6b7280)', marginTop: 4 }}>
                {participants.filter((p) => (hazard === 'WILDFIRE' ? p.wfLvl : p.flLvl) >= evacLevel).length} of {participants.length} participants will be evacuated.
              </div>
            </div>
            <div>
              <label style={labelStyle}>Each care center has:</label>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: '10px' }}>
                <div><label style={labelStyle}>Vans / center</label><input type="number" min={1} max={20} style={inputStyle} value={numVehicles} onChange={(e) => setNumVehicles(Number(e.target.value))} /></div>
                <div><label style={labelStyle}>Capacity</label><input type="number" min={1} max={20} style={inputStyle} value={capacity} onChange={(e) => setCapacity(Number(e.target.value))} /></div>
                <div><label style={labelStyle}>Max trips</label><input type="number" min={1} max={6} style={inputStyle} value={maxTrips} onChange={(e) => setMaxTrips(Number(e.target.value))} /></div>
              </div>
              <div style={{ fontSize: '11px', color: 'var(--text-secondary, #6b7280)', marginTop: 4 }}>
                {depotCount} center(s) &times; {numVehicles} van(s) = <strong>{depotCount * numVehicles}</strong> vans total. Each van can shuttle back to its center up to {maxTrips} times.
              </div>
            </div>
            <button style={btn(!busy)} disabled={busy} onClick={solve}>{busy ? 'Solving…' : '4 · Plan evacuation'}</button>
          </>
        )}

        {planStats && (
          <>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
              <Kpi label="Evacuees" value={planStats.evacuees} />
              <Kpi label="Evacuated" value={planStats.assigned} color="#16a34a" />
              <Kpi label="Trips" value={planStats.trips} />
              <Kpi label="Total drive (min)" value={planStats.totalMin} />
            </div>
            {planStats.autoTrips > 0 && (
              <div style={{ fontSize: '11px', color: 'var(--text-secondary, #6b7280)' }}>
                Raised to {planStats.autoTrips} trips/van to seat every evacuee.
              </div>
            )}
            {planStats.overflow > 0 && (
              <div style={{ fontSize: '11px', color: '#b45309', background: '#fef3c7', padding: '8px 10px', borderRadius: 6 }}>
                {planStats.overflow} participant(s) could not be seated within {depotCount} center(s) &times; {numVehicles} van(s) &times; {capacity} capacity &times; {CEIL_TRIPS} max trips. Add vans/center or capacity. They are ringed in red on the map.
              </div>
            )}
            {trips.length > 0 && (
              <div>
                <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 6 }}>Trips ({trips.length})</div>
                <div style={{ maxHeight: 240, overflow: 'auto', display: 'flex', flexDirection: 'column', gap: 4 }}>
                  {trips.map((t) => {
                    const c = ROUTE_PALETTE[t.physIndex % ROUTE_PALETTE.length];
                    const selected = t.tripKey === selectedTripKey;
                    return (
                      <button key={t.tripKey} onClick={() => setSelectedTripKey(selected ? null : t.tripKey)}
                        style={{ display: 'flex', alignItems: 'center', gap: 8, textAlign: 'left', cursor: 'pointer',
                          padding: '6px 8px', borderRadius: 6, fontSize: 11,
                          border: selected ? `1px solid rgb(${c[0]},${c[1]},${c[2]})` : '1px solid var(--border-default, #e5e7eb)',
                          background: selected ? `rgba(${c[0]},${c[1]},${c[2]},0.10)` : 'transparent', color: 'var(--text-primary, #111827)' }}>
                        <span style={{ width: 10, height: 10, borderRadius: 2, background: `rgb(${c[0]},${c[1]},${c[2]})`, flexShrink: 0 }} />
                        <span style={{ flex: 1 }}>{t.vehicleLabel} - Trip {t.tripNumber}</span>
                        <span style={{ color: 'var(--text-secondary, #6b7280)' }}>{t.load}/{t.capacity} · {Math.round(t.durationSec / 60)}m</span>
                      </button>
                    );
                  })}
                </div>
              </div>
            )}
          </>
        )}
        {error && <div style={{ padding: '10px', borderRadius: '6px', backgroundColor: 'var(--surface-error, #fef2f2)', border: '1px solid var(--border-error, #fecaca)', fontSize: '12px', color: 'var(--text-error, #dc2626)' }}>{error}</div>}
      </div>

      <div style={{ position: 'relative', height: '100%' }}>
        <MapView layers={layers} fitTo={{ coords: fitCoords, focusKey: `${region}:${step}:${participants.length}` }}
          getTooltip={(info: any) => {
            const o = info?.object; if (!o) return null;
            if (o.center_name) return { text: o.center_name };
            if (o.pid) return { text: `${o.address || o.pid} · ${hazard === 'WILDFIRE' ? (o.wfLbl ?? o.wfLvl) : (o.flLbl ?? o.flLvl)}` };
            if (o.properties && o.properties.lvl != null) {
              const lv = Math.max(0, Math.min(5, Math.round(o.properties.lvl || 0)));
              return { text: `${hazard === 'WILDFIRE' ? 'Wildfire' : 'Flood'} risk: ${RISK_LABELS[lv]} (level ${lv})` };
            }
            return null;
          }} />
        <div style={{ position: 'absolute', bottom: 12, left: 12, padding: '8px 10px', borderRadius: '8px', backgroundColor: 'var(--surface-primary, rgba(255,255,255,0.95))', border: '1px solid var(--border-default, #e5e7eb)', boxShadow: '0 1px 3px rgba(0,0,0,0.12)', fontSize: '11px', color: 'var(--text-primary, #111827)' }}>
          <div style={{ fontWeight: 700, marginBottom: 4, textTransform: 'uppercase', fontSize: '10px', letterSpacing: '0.04em', color: 'var(--text-secondary, #6b7280)' }}>{hazard === 'WILDFIRE' ? 'Wildfire' : 'Flood'} risk</div>
          {RISK_LABELS.map((lbl, i) => (
            <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 6, lineHeight: '16px' }}>
              <span style={{ width: 12, height: 12, borderRadius: 2, flex: '0 0 auto', backgroundColor: `rgb(${RISK_RGB[i].join(',')})` }} />
              <span>{lbl}</span>
            </div>
          ))}
          <div style={{ fontWeight: 700, margin: '8px 0 4px', textTransform: 'uppercase', fontSize: '10px', letterSpacing: '0.04em', color: 'var(--text-secondary, #6b7280)', borderTop: '1px solid var(--border-default, #e5e7eb)', paddingTop: 6 }}>Map features</div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, lineHeight: '16px' }}>
            <span style={{ width: 14, height: 10, flex: '0 0 auto', border: '1.5px solid rgb(37,99,235)', backgroundColor: 'rgba(37,99,235,0.12)', borderRadius: 2 }} />
            <span>Reachable area ({minutes}-min drive from centers)</span>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, lineHeight: '16px' }}>
            <span style={{ width: 12, height: 12, borderRadius: '50%', flex: '0 0 auto', backgroundColor: 'rgb(17,24,39)' }} />
            <span>Care center (depot)</span>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, lineHeight: '16px' }}>
            <span style={{ width: 12, height: 12, borderRadius: '50%', flex: '0 0 auto', backgroundColor: 'rgb(234,179,8)', border: '1px solid rgb(15,23,42)' }} />
            <span>Participant (color = risk)</span>
          </div>
        </div>
      </div>
    </div>
  );
}

function Kpi({ label, value, color }: { label: string; value: number | string; color?: string }) {
  return (
    <div style={{ padding: '8px 10px', borderRadius: 8, border: '1px solid var(--border-default, #e5e7eb)', background: 'var(--surface-primary, #fff)' }}>
      <div style={{ fontSize: 10, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.04em', color: 'var(--text-secondary, #6b7280)' }}>{label}</div>
      <div style={{ fontSize: 20, fontWeight: 700, color: color || 'var(--text-primary, #111827)' }}>{value}</div>
    </div>
  );
}

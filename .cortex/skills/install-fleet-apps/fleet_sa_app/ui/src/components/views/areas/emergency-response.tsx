'use client';

// Tier-3 showcase: region-generic Emergency Response evacuation wizard.
//
// Runs for WHATEVER region/dataset is active (no country lock). Data comes from
// the neutral FLEET_APP.EMERGENCY_RESPONSE contract (procedural hazard zones +
// Overture health-anchor care centers, produced by Data Studio) and the
// evac_seed / evac_solve User verbs. Works worldwide; when the active region has
// no hazard/anchor data the wizard shows an actionable empty state.
//
// Steps: 1) hazard-zone risk choropleth  2) seed participants (isochrone union)
//        3) configure vans  4) solve the capacitated multi-depot evacuation VRP.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { GeoJsonLayer, ScatterplotLayer } from '@deck.gl/layers';
import type { Layer } from '@deck.gl/core';
import MapView from './map-view';
import { useAppStore } from '@/lib/store';
import type { LngLat } from '@/lib/map/map-fit';
import type { ViewProps, MapStateDescriptor, MapLayerDescriptor } from '@/lib/types';
import { parseSvcStatus, regionServiceName } from '@/lib/routing-suspend';

type Hazard = 'WILDFIRE' | 'FLOOD';
interface HazardZone { zoneId: string; geojson: string; wildfire_level: number; flood_level: number; }
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

// Join a list into a bounded string for agent context, appending "(+N more)"
// when truncated so the injected panel-context line stays small.
function boundedList(items: string[], max: number): string {
  if (items.length <= max) return items.join('; ');
  return items.slice(0, max).join('; ') + `; (+${items.length - max} more)`;
}

interface PlanStop { seq: number; lon: number; lat: number; pid: string; }
interface PlanTrip {
  tripKey: string; physIndex: number; vehicleLabel: string; vehicleId: number;
  tripNumber: number; stops: PlanStop[]; load: number; capacity: number; durationSec: number;
  centerName: string; distanceM: number;
}
interface PlanStats { evacuees: number; assigned: number; trips: number; totalMin: number; completionMin: number; overflow: number; autoTrips: number; splitForSpeed: boolean; tripCap: number; }
// All vans at a center are identical to VROOM (same depot/capacity); the physical
// van + trip number is assigned AFTER the solve by scheduling each center's routes
// across its vans, so meta only needs the originating center.
interface VehicleMeta { centerIndex: number; centerName: string; capacity: number; }

// Parse native VROOM routes[] into trips, then PARALLELIZE: each VROOM route is an
// independent depot round-trip, so the routes VROOM returns for a center can run
// simultaneously on that center's vans. We schedule them across `vansPerCenter`
// vans with LPT (longest-processing-time first) to minimise the per-center
// makespan, then label each trip "<center> - Van j - Trip t". Job-step ids map
// back to participant pids via jobParticipant; stop coords come from our own
// evacuee list so we never depend on VROOM echoing step locations.
function parseRoutes(
  routes: any[],
  evacuees: Participant[],
  vehicleMeta: Record<number, VehicleMeta>,
  jobParticipant: Record<number, string>,
  vansPerCenter: number,
): { trips: PlanTrip[]; assigned: number } {
  const byPid: Record<string, Participant> = {};
  for (const p of evacuees) byPid[p.pid] = p;
  type Raw = { centerIndex: number; centerName: string; capacity: number; vehicleId: number; stops: PlanStop[]; durationSec: number; distanceM: number };
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
    raws.push({ centerIndex: meta.centerIndex, centerName: meta.centerName, capacity: meta.capacity, vehicleId: vid, stops, durationSec: Number(route?.duration) || 0, distanceM: Number(route?.distance) || 0 });
  }
  // Group routes by originating center, then LPT-schedule across that center's vans.
  const groups: Record<number, Raw[]> = {};
  for (const r of raws) (groups[r.centerIndex] ||= []).push(r);
  const lanes = Math.max(1, vansPerCenter);
  const trips: PlanTrip[] = [];
  for (const centerIndex of Object.keys(groups).map(Number).sort((a, b) => a - b)) {
    const g = groups[centerIndex].slice().sort((a, b) => b.durationSec - a.durationSec);
    const bins = Array.from({ length: lanes }, () => ({ load: 0, count: 0 }));
    for (const r of g) {
      // Assign to the currently least-loaded van (ties -> lowest van index).
      let b = 0;
      for (let j = 1; j < lanes; j++) if (bins[j].load < bins[b].load) b = j;
      bins[b].count += 1;
      bins[b].load += r.durationSec;
      const tripNumber = bins[b].count;
      const physIndex = centerIndex * lanes + b; // stable per physical van (for colour)
      trips.push({
        tripKey: `${centerIndex}:${b}:${tripNumber}`, physIndex,
        vehicleLabel: `${r.centerName} - Vehicle ${b + 1}`, vehicleId: r.vehicleId,
        tripNumber, stops: r.stops, load: r.stops.length, capacity: r.capacity, durationSec: r.durationSec,
        centerName: r.centerName, distanceM: r.distanceM,
      });
    }
  }
  // Display order: by van, then trip number, so each van's trips group together.
  trips.sort((a, b) => a.physIndex - b.physIndex || a.tripNumber - b.tripNumber);
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

// True when an error is the SPCS-ingress timeout class (the 504 "busy (timed
// out)" surfaced by parseJsonOrThrow, or an upstream/gateway timeout). Used to
// decide whether a routing call is worth a warm-up + retry vs a hard failure.
function isTimeoutError(e: unknown): boolean {
  const m = String((e as Error)?.message ?? '');
  return /busy \(timed out\)|timed out|upstream|gateway|\b504\b/i.test(m);
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

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Call an OPS-bundle synapse verb via /api/ops (service_status / service_control).
// Resuming a service is an ops action; a pure consumer (no FLEET_APP_OPS/ADMIN)
// gets HTTP 403, which we surface as { forbidden:true } so the caller can fall
// back to an accurate message + manual command instead of throwing. Other
// non-ok responses (and a "does not exist" 500) throw so the caller can classify.
async function apiOps(verb: string, args: unknown[]): Promise<{ forbidden: boolean; result: Record<string, unknown> }> {
  const res = await fetch('/api/ops', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ verb, args }),
  });
  if (res.status === 403) return { forbidden: true, result: {} };
  const body = await parseJsonOrThrow(res);
  return { forbidden: false, result: (body.result as Record<string, unknown>) ?? {} };
}

// Classify a service_status result. SYSTEM$GET_SERVICE_STATUS returns a JSON array
// of per-instance objects with a `status` field; an empty array / missing json
// means the service exists but has no running instances (suspended). A truly
// non-existent service makes the ops call THROW ("does not exist"), handled by
// the caller, so this never returns MISSING. (Shared impl in lib/routing-suspend.)

type EnsureOutcome = 'running' | 'resumed' | 'timeout' | 'missing' | 'forbidden';

// Ensure a region's VROOM optimization service is RUNNING: probe status, resume
// if suspended, and poll until ready (cap ~150s). Returns a typed outcome the
// wizard maps to a message or a solve retry. `missing` = service not provisioned
// for the region; `forbidden` = caller lacks ops rights (degrade to manual).
async function ensureOptimizationService(svc: string): Promise<EnsureOutcome> {
  const isMissing = (e: unknown) => /does not exist|not exist|not authorized|unknown (service|object)/i.test(String((e as Error)?.message ?? ''));
  // 1. Probe current status.
  try {
    const s = await apiOps('service_status', [svc]);
    if (s.forbidden) return 'forbidden';
    if (parseSvcStatus(s.result) === 'RUNNING') return 'running';
  } catch (e) {
    if (isMissing(e)) return 'missing';
    // transient / unknown -> fall through to a resume attempt
  }
  // 2. Resume (idempotent; ALTER SERVICE IF EXISTS RESUME).
  try {
    const c = await apiOps('service_control', [svc, 'RESUME']);
    if (c.forbidden) return 'forbidden';
  } catch (e) {
    if (isMissing(e)) return 'missing';
    throw e;
  }
  // 3. Poll until RUNNING or ~150s.
  const deadline = Date.now() + 150000;
  while (Date.now() < deadline) {
    await sleep(5000);
    try {
      const s = await apiOps('service_status', [svc]);
      if (s.forbidden) return 'forbidden';
      if (parseSvcStatus(s.result) === 'RUNNING') return 'resumed';
    } catch { /* GET_SERVICE_STATUS is flaky during startup; keep polling */ }
  }
  return 'timeout';
}

export function EmergencyResponseView({ onStateChange }: Partial<ViewProps> = {}) {
  const region = useAppStore((s) => s.context['region']) as string | undefined;
  const setMapState = useAppStore((s) => s.setMapState);

  const [avail, setAvail] = useState<'checking' | 'ready' | 'unavailable'>('checking');
  const [step, setStep] = useState(1);
  const [hazard, setHazard] = useState<Hazard>('WILDFIRE');
  const [zones, setZones] = useState<HazardZone[]>([]);
  const [centers, setCenters] = useState<CareCenter[]>([]);
  const [minutes, setMinutes] = useState(15);
  const [targetCount, setTargetCount] = useState(60);
  const [participants, setParticipants] = useState<Participant[]>([]);
  const [unionGeo, setUnionGeo] = useState<GeoJSON.Geometry | null>(null);
  const [numVehicles, setNumVehicles] = useState(4);
  const [capacity, setCapacity] = useState(6);
  const [maxTrips, setMaxTrips] = useState(3);
  const [optimizeMode, setOptimizeMode] = useState<'fastest' | 'fewest'>('fastest');
  const [evacLevel, setEvacLevel] = useState(3);
  const [routeGeo, setRouteGeo] = useState<GeoJSON.FeatureCollection | null>(null);
  const [trips, setTrips] = useState<PlanTrip[]>([]);
  const [planStats, setPlanStats] = useState<PlanStats | null>(null);
  const [selectedTripKey, setSelectedTripKey] = useState<string | null>(null);
  const [unassignedPids, setUnassignedPids] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  // Every loaded/seeded care center is a depot (no cap); the "Vans" input is the
  // van count PER center, so total fleet = centers x vans.
  const depotCount = centers.length;

  // Per-band participant counts for the ACTIVE hazard (matches the colored dots
  // on the map) so the agent can answer "how many are in the Very High band"
  // without a re-seed.
  const riskBandBreakdown = useMemo(() => {
    const c = [0, 0, 0, 0, 0, 0];
    for (const p of participants) {
      const lvl = hazard === 'WILDFIRE' ? p.wfLvl : p.flLvl;
      c[Math.max(0, Math.min(5, Math.round(lvl || 0)))]++;
    }
    return c;
  }, [participants, hazard]);

  // Participant ADDRESSES grouped by ACTIVE-hazard risk band, so the agent can
  // answer "give me the addresses of the Very High points". risk_bands only
  // carries per-band COUNTS and the trip roster only carries seated addresses
  // (untagged) - neither joins address<->risk at the participant level, so we
  // surface that join here directly from the same `participants` state that
  // draws the colored map dots.
  const addressesByBand = useMemo(() => {
    const groups: string[][] = [[], [], [], [], [], []];
    for (const p of participants) {
      const lvl = hazard === 'WILDFIRE' ? p.wfLvl : p.flLvl;
      const band = Math.max(0, Math.min(5, Math.round(lvl || 0)));
      groups[band].push(p.address || p.pid);
    }
    return groups;
  }, [participants, hazard]);

  // Hazard-zone (county) risk roster for the choropleth on the map. Each zone
  // carries BOTH hazard levels, so the agent can answer "which counties are Very
  // High wildfire risk" / "high flood but low wildfire" even though only the
  // active hazard is currently colored. Sorted by the active-hazard level desc.
  const hazardZonesText = useMemo(() => {
    if (!zones.length) return null;
    const lvlOf = (z: HazardZone) => (hazard === 'WILDFIRE' ? z.wildfire_level : z.flood_level);
    const sorted = zones.slice().sort((a, b) => lvlOf(b) - lvlOf(a));
    return boundedList(sorted.map((z) => `${z.zoneId} (WF b${z.wildfire_level}/FL b${z.flood_level})`), 15);
  }, [zones, hazard]);

  // Per-county participant rollup for the active hazard: total seeded and how
  // many are at/above the evacuation threshold, so the agent can answer "which
  // county has the most at-risk people". Sorted by total desc.
  const participantsByCounty = useMemo(() => {
    if (!participants.length) return null;
    const agg: Record<string, { total: number; atRisk: number }> = {};
    for (const p of participants) {
      const key = p.county || 'Unknown';
      const lvl = Math.round((hazard === 'WILDFIRE' ? p.wfLvl : p.flLvl) || 0);
      const e = (agg[key] ||= { total: 0, atRisk: 0 });
      e.total += 1;
      if (lvl >= evacLevel) e.atRisk += 1;
    }
    const rows = Object.entries(agg)
      .sort((a, b) => b[1].total - a[1].total)
      .map(([c, v]) => `${c}: ${v.total} (${v.atRisk} at/above)`);
    return boundedList(rows, 15);
  }, [participants, hazard, evacLevel]);

  // Counts for the NON-active hazard (mirrors risk_bands) plus how many
  // participants are at/above threshold for BOTH hazards, so the agent can
  // compare flood vs wildfire without the user toggling the hazard control.
  const otherHazardBreakdown = useMemo(() => {
    const c = [0, 0, 0, 0, 0, 0];
    for (const p of participants) {
      const lvl = hazard === 'WILDFIRE' ? p.flLvl : p.wfLvl;
      c[Math.max(0, Math.min(5, Math.round(lvl || 0)))]++;
    }
    return c;
  }, [participants, hazard]);
  const highOnBoth = useMemo(
    () => participants.filter((p) => Math.round(p.wfLvl || 0) >= evacLevel && Math.round(p.flLvl || 0) >= evacLevel).length,
    [participants, evacLevel],
  );

  // Compact, agent-facing scalars/strings describing the solved plan. viewState
  // is flattened to key=value in the panel-context prefix, so the trip roster and
  // gap lists MUST be pre-formatted strings (an array would serialize to
  // "[object Object]"). Fields are null before a solve so they drop from context.
  const planContext = useMemo(() => {
    const addrByPid: Record<string, string> = {};
    const bandByPid: Record<string, number> = {};
    for (const p of participants) {
      addrByPid[p.pid] = p.address || p.pid;
      const lvl = hazard === 'WILDFIRE' ? p.wfLvl : p.flLvl;
      bandByPid[p.pid] = Math.max(0, Math.min(5, Math.round(lvl || 0)));
    }
    // Address + compact risk-band marker ("[bN]", matching the risk_bands legend)
    // so the seated roster is self-describing and the agent can say which stops
    // are Very High without a second lookup.
    const stopLabel = (pid: string) => `${addrByPid[pid] || pid} [b${bandByPid[pid] ?? 0}]`;
    const unassignedAddrs = unassignedPids.map((pid) => addrByPid[pid] || pid);
    const base = {
      unassigned_count: unassignedPids.length || null,
      unassigned_addresses: unassignedPids.length ? boundedList(unassignedAddrs, 12) : null,
    };
    if (!trips.length) {
      return {
        ...base,
        trips_detail: null, vans_used: null, longest_trip_min: null,
        shortest_trip_min: null, total_stops_assigned: null, avg_stops_per_trip: null,
        selected_trip: null, centers_workload: null, total_km: null, longest_trip_km: null,
        seat_utilization: null,
      };
    }
    const totalStops = trips.reduce((a, t) => a + t.stops.length, 0);
    const vans = new Set(trips.map((t) => t.physIndex)).size;
    let longest = 0, shortest = Number.POSITIVE_INFINITY;
    for (const t of trips) { const m = Math.round(t.durationSec / 60); if (m > longest) longest = m; if (m < shortest) shortest = m; }
    // Per-center workload rollup: seated evacuees, trip count, and distinct vans
    // used at each depot, so "which center is busiest" is answerable directly.
    const byCenter: Record<string, { evac: number; trips: number; vans: Set<number> }> = {};
    for (const t of trips) {
      const e = (byCenter[t.centerName] ||= { evac: 0, trips: 0, vans: new Set() });
      e.evac += t.stops.length; e.trips += 1; e.vans.add(t.physIndex);
    }
    const centersWorkload = boundedList(
      Object.entries(byCenter)
        .sort((a, b) => b[1].evac - a[1].evac)
        .map(([c, v]) => `${c}: ${v.evac} evacuees, ${v.trips} trips, ${v.vans.size} vans`),
      12,
    );
    // Trip-by-trip roster GROUPED BY CENTER, centers ordered by workload (desc, to
    // match centers_workload) so the busiest depots - the ones users ask about -
    // are listed first and stay complete under truncation. Each center block lists
    // its trips (per-van label, minutes, load/capacity, risk-tagged stops). The
    // roster's total stop tokens ~= assigned participants, so a full grouping is
    // small enough to inject; caps keep it bounded at large solves with "(+N more)".
    const MAX_CENTERS_LISTED = 10;
    const MAX_TRIPS_PER_CENTER = 20;
    const MAX_STOPS_PER_TRIP = 15;
    const tripsByCenter: Record<string, PlanTrip[]> = {};
    for (const t of trips) (tripsByCenter[t.centerName] ||= []).push(t);
    const centerBlocks = Object.entries(byCenter)
      .sort((a, b) => b[1].evac - a[1].evac)
      .map(([c, agg]) => {
        const lines = tripsByCenter[c].map(
          (t) => `T${t.tripNumber} ${t.vehicleLabel.replace(`${c} - `, '')} ${Math.round(t.durationSec / 60)}m [${t.load}/${t.capacity}]: ${boundedList(t.stops.map((s) => stopLabel(s.pid)), MAX_STOPS_PER_TRIP)}`,
        );
        return `${c} (${agg.evac} evacuees, ${agg.trips} trips, ${agg.vans.size} vans): ${boundedList(lines, MAX_TRIPS_PER_CENTER)}`;
      });
    const tripsDetail = boundedList(centerBlocks, MAX_CENTERS_LISTED);
    // Route distance (km). VROOM returns distance per route; if absent (all 0)
    // we publish null rather than a misleading 0.
    const totalMeters = trips.reduce((a, t) => a + (t.distanceM || 0), 0);
    const maxMeters = trips.reduce((a, t) => Math.max(a, t.distanceM || 0), 0);
    const totalKm = totalMeters > 0 ? Math.round(totalMeters / 100) / 10 : null;
    const longestKm = maxMeters > 0 ? Math.round(maxMeters / 100) / 10 : null;
    // Seat utilization: assigned pickups vs total seats offered across trips.
    const seatsOffered = trips.reduce((a, t) => a + t.capacity, 0);
    const seatUtil = seatsOffered > 0
      ? `${totalStops}/${seatsOffered} seats (${Math.round((totalStops / seatsOffered) * 100)}% full)`
      : null;
    const sel = selectedTripKey ? trips.find((t) => t.tripKey === selectedTripKey) : undefined;
    return {
      ...base,
      trips_detail: tripsDetail,
      vans_used: vans,
      longest_trip_min: longest,
      shortest_trip_min: Number.isFinite(shortest) ? shortest : null,
      total_stops_assigned: totalStops,
      avg_stops_per_trip: Math.round((totalStops / trips.length) * 10) / 10,
      centers_workload: centersWorkload,
      total_km: totalKm,
      longest_trip_km: longestKm,
      seat_utilization: seatUtil,
      selected_trip: sel
        ? `${sel.vehicleLabel} Trip ${sel.tripNumber}: ${sel.load}/${sel.capacity} seats, ${Math.round(sel.durationSec / 60)}m, stops: ${boundedList(sel.stops.map((s) => stopLabel(s.pid)), MAX_STOPS_PER_TRIP)}`
        : null,
    };
  }, [trips, participants, unassignedPids, selectedTripKey, hazard]);

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
    reachable_minutes: minutes,
    participants_seeded: participants.length,
    risk_threshold: `${RISK_LABELS[evacLevel]} (level ${evacLevel})`,
    risk_bands: participants.length ? RISK_LABELS.map((l, i) => `${l}(${i}):${riskBandBreakdown[i]}`).join(', ') : null,
    addresses_by_band: participants.length
      ? RISK_LABELS.map((l, i) => [l, i] as const)
          .filter(([, i]) => addressesByBand[i].length)
          .sort((a, b) => b[1] - a[1])
          .map(([l, i]) => `${l}(${i}): ${boundedList(addressesByBand[i], 10)}`)
          .join(' | ')
      : null,
    at_or_above_threshold: participants.length ? riskBandBreakdown.slice(evacLevel).reduce((a, b) => a + b, 0) : null,
    other_hazard: hazard === 'WILDFIRE' ? 'FLOOD' : 'WILDFIRE',
    other_hazard_bands: participants.length ? RISK_LABELS.map((l, i) => `${l}(${i}):${otherHazardBreakdown[i]}`).join(', ') : null,
    high_on_both_hazards: participants.length ? highOnBoth : null,
    participants_by_county: participantsByCounty,
    zone_count: zones.length || null,
    hazard_zones: hazardZonesText,
    center_names: centers.length ? boundedList(centers.map((c) => c.center_name).filter(Boolean), 12) : null,
    vans_per_center: numVehicles,
    depot_count: depotCount,
    total_vans: depotCount * numVehicles,
    capacity_per_van: capacity,
    max_trips_per_van: maxTrips,
    optimize_mode: optimizeMode,
    evacuees: planStats?.evacuees ?? null,
    assigned: planStats?.assigned ?? null,
    trips: planStats?.trips ?? null,
    completion_min: planStats?.completionMin ?? null,
    total_drive_min: planStats?.totalMin ?? null,
    overflow: planStats?.overflow ?? null,
    ...planContext,
    step,
    availability: avail,
  }), [region, hazard, minutes, participants.length, evacLevel, riskBandBreakdown, addressesByBand, otherHazardBreakdown, highOnBoth, participantsByCounty, zones.length, hazardZonesText, centers, numVehicles, capacity, maxTrips, optimizeMode, planStats, planContext, step, avail, depotCount]);

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
        const zones2 = hz.map((r) => ({
          zoneId: String(r.county ?? ''), geojson: String(r.geojson ?? ''),
          wildfire_level: Number(r.wildfire_level ?? 0), flood_level: Number(r.flood_level ?? 0),
        })).filter((c) => c.geojson);
        const centers2 = cc.map((r) => ({
          center_id: String(r.center_id ?? ''), center_name: String(r.center_name ?? ''),
          lon: Number(r.lon), lat: Number(r.lat),
        })).filter((c) => Number.isFinite(c.lon) && Number.isFinite(c.lat));
        setZones(zones2); setCenters(centers2);
        setAvail(zones2.length > 0 && centers2.length > 0 ? 'ready' : 'unavailable');
      } catch (e) {
        if (!cancelled) { setError(e instanceof Error ? e.message : 'load failed'); setAvail('unavailable'); }
      }
    })();
    return () => { cancelled = true; };
  }, [region]);

  const seed = useCallback(async () => {
    setBusy(true); setError(null); setNotice(null); setRouteGeo(null);
    setTrips([]); setPlanStats(null); setSelectedTripKey(null); setUnassignedPids([]);
    try {
      // The seed's multi-center isochrone call over a large region can spike past
      // the SPCS ingress ceiling on a cold/rescheduled ORS instance, surfacing as
      // a 504 "busy (timed out)". Mirror the solve path: on a timeout, warm the
      // region's ORS service and retry ONCE instead of dead-ending on a transient
      // spike (warm, the whole seed completes in ~10s).
      const seedArgs = [region ?? null, hazard, minutes, targetCount];
      const regionLbl = region ?? 'the active region';
      let r: Record<string, unknown>;
      try {
        r = await apiTool('evac_seed', seedArgs);
      } catch (e) {
        if (!isTimeoutError(e)) throw e;
        setNotice(`Routing engine is warming up for ${regionLbl}. Retrying...`);
        const orsSvc = regionServiceName(region, 'ORS');
        let outcome: EnsureOutcome = 'timeout';
        try { outcome = await ensureOptimizationService(orsSvc); } catch { /* best-effort warm; retry regardless */ }
        await sleep(outcome === 'resumed' ? 8000 : 3000);
        try {
          r = await apiTool('evac_seed', seedArgs);
        } catch (e2) {
          if (isTimeoutError(e2)) {
            throw new Error(`Routing engine is still busy for ${regionLbl}. The region road graph may be warming up - wait ~30s and try again, or reduce the travel time.`);
          }
          throw e2;
        }
        setNotice(null);
      }
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
    finally { setBusy(false); setNotice(null); }
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
    setBusy(true); setError(null); setNotice(null);
    setTrips([]); setPlanStats(null); setSelectedTripKey(null); setUnassignedPids([]);
    try {
      // Every seeded/loaded care center is a depot holding `vansPerCenter` vans.
      // Vans at a center are interchangeable to VROOM, so we just offer a POOL of
      // identical vehicles per center (vans x trips) and let VROOM pick how many
      // routes each center needs; parseRoutes then schedules those routes across
      // the center's vans IN PARALLEL (makespan), so vans actually run concurrently
      // instead of one van shuttling sequentially. Trip count auto-raises so total
      // seats (centers*vans*capacity*trips) cover every evacuee, capped at CEIL_TRIPS.
      // Total vehicles offered is capped at MAX_VEHICLES (VROOM maxvehicles=200).
      const MAX_VEHICLES = 190;
      const depots = centers;
      const vansPerCenter = Math.max(1, numVehicles);
      const cap = Math.max(1, capacity);
      const totalVans = Math.max(1, depots.length * vansPerCenter);
      // Split-for-speed: VROOM minimises TOTAL drive, so it consolidates evacuees
      // into the fewest, fullest trips and leaves spare vans idle -> the busiest van
      // (the makespan) does one long loop. To finish sooner we cap each trip's
      // pickups so VROOM must spread work across all vans in parallel. The cap is
      // driven by van count (not capacity), so completion no longer worsens with
      // bigger capacity; capacity stays the seat upper-bound. 'fewest' keeps the
      // consolidate behaviour. Only binds when it would actually split (< cap).
      const parallelTasks = Math.max(1, Math.min(cap, Math.ceil(evacuees.length / totalVans)));
      const splitForSpeed = optimizeMode === 'fastest' && parallelTasks < cap;
      const tripCap = splitForSpeed ? parallelTasks : cap; // effective pickups per trip
      const neededTrips = Math.ceil(evacuees.length / (totalVans * tripCap));
      const effTrips = Math.min(CEIL_TRIPS, Math.max(Math.max(1, maxTrips), neededTrips));
      let perCenterOffer = vansPerCenter * effTrips;
      if (depots.length * perCenterOffer > MAX_VEHICLES) {
        perCenterOffer = Math.max(vansPerCenter, Math.floor(MAX_VEHICLES / Math.max(1, depots.length)));
      }
      const vehicles: unknown[] = [];
      const vehicleMeta: Record<number, VehicleMeta> = {};
      let vid = 1;
      depots.forEach((d, ci) => {
        for (let s = 0; s < perCenterOffer; s++) {
          const veh: Record<string, unknown> = { id: vid, start: [d.lon, d.lat], end: [d.lon, d.lat], profile: 'driving-car', capacity: [cap] };
          if (splitForSpeed) veh.max_tasks = tripCap; // force parallel spread across vans
          vehicles.push(veh);
          vehicleMeta[vid] = { centerIndex: ci, centerName: d.center_name, capacity: cap };
          vid++;
        }
      });
      const jobParticipant: Record<number, string> = {};
      const jobs = evacuees.map((p, i) => {
        jobParticipant[i + 1] = p.pid;
        return { id: i + 1, location: [p.lon, p.lat], pickup: [1], description: p.pid };
      });
      const challenge = JSON.stringify({ vehicles, jobs });
      const regionLbl = region ?? 'the active region';
      const defaultSvc = regionServiceName(region, 'VROOM');
      let r = await apiTool('evac_solve', [challenge, region ?? null]);
      let ensured = false;
      // The proc returns reason 'OPTIMIZATION_UNAVAILABLE' when the region's VROOM
      // service is suspended or cold-starting. Resume it, wait, and retry rather
      // than blaming participant routability.
      if (r.status !== 'SUCCESS' && r.reason === 'OPTIMIZATION_UNAVAILABLE') {
        const svc = String(r.vroom_service || defaultSvc);
        setNotice(`Starting the route optimization service for ${regionLbl}. This can take up to ~2 minutes...`);
        const outcome = await ensureOptimizationService(svc);
        if (outcome === 'forbidden') {
          setNotice(null);
          setError(`The route optimization service for ${regionLbl} is not running. Ask an operator to resume it, or run:  ALTER SERVICE ${svc} RESUME;  then click Plan evacuation again.`);
          return;
        }
        if (outcome === 'missing') {
          setNotice(null);
          setError(`Route optimization is not provisioned for ${regionLbl}. Provision it in the Admin app Region Builder, then retry.`);
          return;
        }
        if (outcome === 'timeout') {
          setNotice(null);
          setError(`The route optimization service for ${regionLbl} is still starting. Wait a moment and click Plan evacuation again.`);
          return;
        }
        // running / resumed: give a freshly-resumed engine a moment to warm its
        // graph, then retry (once more on a slow cold start).
        ensured = true;
        setNotice('Optimization service is ready. Planning routes...');
        await sleep(outcome === 'resumed' ? 8000 : 2000);
        r = await apiTool('evac_solve', [challenge, region ?? null]);
        if (r.status !== 'SUCCESS' && r.reason === 'OPTIMIZATION_UNAVAILABLE') {
          await sleep(8000);
          r = await apiTool('evac_solve', [challenge, region ?? null]);
        }
        setNotice(null);
      }
      if (r.status !== 'SUCCESS') {
        // VROOM confirmed reachable but still no plan -> genuine routability.
        if (ensured && r.reason === 'OPTIMIZATION_UNAVAILABLE') {
          throw new Error('The optimization service is running but returned no routes. Some participants may be off the road network for this region.');
        }
        throw new Error(String(r.error || 'Solve failed'));
      }
      const geo = r.geometry as GeoJSON.FeatureCollection | GeoJSON.Geometry | null;
      const fc: GeoJSON.FeatureCollection = geo && (geo as GeoJSON.FeatureCollection).type === 'FeatureCollection'
        ? (geo as GeoJSON.FeatureCollection)
        : { type: 'FeatureCollection', features: geo ? [{ type: 'Feature', geometry: geo as GeoJSON.Geometry, properties: {} }] : [] };
      setRouteGeo(fc);

      // Build trips + coverage stats from the routes VROOM actually returned.
      const routes = (r.routes as any[]) ?? [];
      const { trips: parsed, assigned } = parseRoutes(routes, evacuees, vehicleMeta, jobParticipant, vansPerCenter);
      setTrips(parsed);
      const assignedPids = new Set(parsed.flatMap((t) => t.stops.map((s) => s.pid)));
      setUnassignedPids(evacuees.filter((p) => !assignedPids.has(p.pid)).map((p) => p.pid));
      const totalMin = Math.round(parsed.reduce((a, t) => a + t.durationSec, 0) / 60);
      // Completion time = parallel makespan: vans run concurrently, so the plan is
      // done when the busiest van finishes (max over vans of its summed trip time).
      const vanLoad: Record<number, number> = {};
      for (const t of parsed) vanLoad[t.physIndex] = (vanLoad[t.physIndex] || 0) + t.durationSec;
      const completionMin = Math.round(Math.max(0, ...Object.values(vanLoad), 0) / 60);
      setPlanStats({
        evacuees: evacuees.length, assigned, trips: parsed.length, totalMin, completionMin,
        overflow: Math.max(0, evacuees.length - assigned),
        autoTrips: effTrips > Math.max(1, maxTrips) ? effTrips : 0,
        splitForSpeed, tripCap,
      });
      setStep(4);
    } catch (e) { setError(e instanceof Error ? e.message : 'Solve failed'); }
    finally { setBusy(false); setNotice(null); }
  }, [centers, numVehicles, maxTrips, capacity, participants, hazard, evacLevel, region, optimizeMode]);

  // deck.gl layers per current state.
  const layers = useMemo<Layer[]>(() => {
    const out: Layer[] = [];
    if (zones.length) {
      const features = zones.map((c) => {
        let g: GeoJSON.Geometry | null = null;
        try { g = JSON.parse(c.geojson); } catch { g = null; }
        const lvl = hazard === 'WILDFIRE' ? c.wildfire_level : c.flood_level;
        return g ? { type: 'Feature' as const, geometry: g, properties: { zone: c.zoneId, lvl } } : null;
      }).filter(Boolean) as GeoJSON.Feature[];
      out.push(new GeoJsonLayer({
        id: 'hazard-zones', data: { type: 'FeatureCollection', features },
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
  }, [zones, hazard, evacLevel, unionGeo, centers, participants, routeGeo, unassignedPids, selectedTripKey, trips]);

  const fitCoords = useMemo<LngLat[]>(() => {
    const c: LngLat[] = [];
    for (const p of participants) c.push([p.lon, p.lat]);
    if (!participants.length) for (const ce of centers) c.push([ce.lon, ce.lat]);
    return c;
  }, [participants, centers]);

  // Publish a scalar-only descriptor of the deck.gl layers actually on screen so
  // the agent answers "what is on the map / why is layer X blank" from real
  // state (mirrors the generic view-map.tsx map-awareness channel, which this
  // custom view does not otherwise feed). Per-feature rows are intentionally
  // excluded - the trip roster travels via the viewState summary instead.
  const mapDescriptor = useMemo<MapStateDescriptor>(() => {
    const routeFeatures = routeGeo?.features?.length ?? 0;
    const selStops = selectedTripKey ? (trips.find((t) => t.tripKey === selectedTripKey)?.stops.length ?? 0) : 0;
    const defs: MapLayerDescriptor[] = [
      { id: 'hazard-zones', type: 'GeoJsonLayer', featureCount: zones.length, colorBy: hazard === 'WILDFIRE' ? 'wildfire risk' : 'flood risk', rendered: zones.length > 0, gated: false },
      { id: 'iso-union', type: 'GeoJsonLayer', featureCount: unionGeo ? 1 : 0, rendered: !!unionGeo, gated: false },
      { id: 'centers', type: 'ScatterplotLayer', featureCount: centers.length, rendered: centers.length > 0, gated: false },
      { id: 'participants', type: 'ScatterplotLayer', featureCount: participants.length, colorBy: 'risk level', rendered: participants.length > 0, gated: false },
      { id: 'routes', type: 'GeoJsonLayer', featureCount: routeFeatures, colorBy: 'van', rendered: routeFeatures > 0, gated: false },
      { id: 'unassigned', type: 'ScatterplotLayer', featureCount: unassignedPids.length, rendered: unassignedPids.length > 0, gated: false },
      { id: 'selected-stops', type: 'ScatterplotLayer', featureCount: selStops, rendered: selStops > 0, gated: false },
    ];
    const emptyLayers = defs.filter((l) => l.featureCount === 0).map((l) => l.id);
    let bbox: [number, number, number, number] | undefined;
    if (fitCoords.length) {
      let minLng = Infinity, minLat = Infinity, maxLng = -Infinity, maxLat = -Infinity;
      for (const [lng, lat] of fitCoords) {
        if (lng < minLng) minLng = lng; if (lat < minLat) minLat = lat;
        if (lng > maxLng) maxLng = lng; if (lat > maxLat) maxLat = lat;
      }
      bbox = [minLng, minLat, maxLng, maxLat];
    }
    const sel = selectedTripKey ? trips.find((t) => t.tripKey === selectedTripKey) : undefined;
    return {
      layerCount: defs.length,
      layers: defs,
      emptyLayers,
      bbox,
      selection: sel ? { selected_trip: `${sel.vehicleLabel} Trip ${sel.tripNumber}` } : undefined,
      legend: [...RISK_LABELS, 'Reachable area', 'Care center', 'Participant'],
    };
  }, [zones.length, unionGeo, centers.length, participants.length, routeGeo, unassignedPids.length, selectedTripKey, trips, hazard, fitCoords]);

  const lastMapSigRef = useRef<string>('');
  useEffect(() => {
    // Only advertise a map while the view actually renders one (avail === 'ready');
    // otherwise clear so the agent does not see phantom all-blank layers.
    if (avail !== 'ready') {
      if (lastMapSigRef.current !== '') { lastMapSigRef.current = ''; setMapState(null); }
      return;
    }
    const sig = JSON.stringify(mapDescriptor);
    if (sig === lastMapSigRef.current) return;
    lastMapSigRef.current = sig;
    setMapState(mapDescriptor);
  }, [mapDescriptor, setMapState, avail]);
  useEffect(() => () => setMapState(null), [setMapState]);

  const labelStyle = { fontSize: '12px', fontWeight: 600, color: 'var(--text-secondary, #6b7280)', textTransform: 'uppercase' as const, marginBottom: '4px', display: 'block' };
  const subLabelStyle = { fontSize: '11px', fontWeight: 600, color: 'var(--text-secondary, #6b7280)', textTransform: 'uppercase' as const, letterSpacing: '0.02em', marginBottom: '4px', display: 'block', whiteSpace: 'nowrap' as const };
  const inputStyle = { width: '100%', padding: '8px 10px', fontSize: '13px', borderRadius: '6px', border: '1px solid var(--border-default, #e5e7eb)', backgroundColor: 'var(--surface-primary, #fff)', color: 'var(--text-primary, #111827)' };
  const btn = (enabled: boolean) => ({ padding: '8px 16px', fontSize: '13px', fontWeight: 600, borderRadius: '6px', border: 'none', cursor: enabled ? 'pointer' : 'not-allowed', backgroundColor: 'var(--surface-accent-strong, #2563eb)', color: '#fff', opacity: enabled ? 1 : 0.6 });

  if (avail === 'unavailable') {
    return (
      <div style={{ padding: '24px', maxWidth: 640 }}>
        <h2 style={{ fontSize: '16px', fontWeight: 700, margin: '0 0 8px' }}>Emergency Response</h2>
        <div style={{ padding: '16px', borderRadius: '8px', backgroundColor: 'var(--surface-warning, #fffbeb)', border: '1px solid var(--border-warning, #fde68a)', fontSize: '13px', color: 'var(--text-primary, #111827)' }}>
          <p style={{ margin: '0 0 8px', fontWeight: 600 }}>No Emergency Response data for {region || 'the active region'}.</p>
          <p style={{ margin: 0 }}>
            This use case needs hazard-zone and health-anchor data. In the <strong>Data Studio</strong> (Admin app),
            run a generation for this region with <strong>Hazard</strong>, <strong>Anchors</strong>, and <strong>Participants</strong> enabled, then re-open this page.
            Hazard zones are generated per region worldwide (no country restriction).
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
            Evacuation planning for <strong>{region || 'active region'}</strong> · {zones.length} hazard zones · {centers.length} care centers
          </p>
        </div>

        <div>
          <label style={labelStyle}>1 · Hazard</label>
          <select style={inputStyle} value={hazard} onChange={(e) => setHazard(e.target.value as Hazard)}>
            <option value="WILDFIRE">Wildfire</option>
            <option value="FLOOD">Flood</option>
          </select>
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '10px', alignItems: 'end' }}>
          <div>
            <label style={subLabelStyle}>2 · Isochrone min</label>
            <input type="number" min={1} max={60} style={inputStyle} value={minutes} onChange={(e) => setMinutes(Number(e.target.value))} />
          </div>
          <div>
            <label style={subLabelStyle}>Participants</label>
            <input type="number" min={1} max={300} style={inputStyle} value={targetCount} onChange={(e) => setTargetCount(Number(e.target.value))} />
          </div>
        </div>
        <button style={btn(!busy)} disabled={busy} onClick={seed}>{busy ? (notice ? 'Working…' : 'Seeding…') : 'Seed participants'}</button>

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
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: '10px', alignItems: 'end' }}>
                <div><label style={subLabelStyle}>Vehicles</label><input type="number" min={1} max={20} style={inputStyle} value={numVehicles} onChange={(e) => setNumVehicles(Number(e.target.value))} /></div>
                <div><label style={subLabelStyle}>Capacity</label><input type="number" min={1} max={20} style={inputStyle} value={capacity} onChange={(e) => setCapacity(Number(e.target.value))} /></div>
                <div><label style={subLabelStyle}>Max trips</label><input type="number" min={1} max={6} style={inputStyle} value={maxTrips} onChange={(e) => setMaxTrips(Number(e.target.value))} /></div>
              </div>
              <div style={{ fontSize: '11px', color: 'var(--text-secondary, #6b7280)', marginTop: 4 }}>
                {depotCount} center(s) &times; {numVehicles} vehicle(s) = <strong>{depotCount * numVehicles}</strong> vehicles total. Each vehicle can shuttle back to its center up to {maxTrips} times.
              </div>
            </div>
            <div>
              <label style={labelStyle}>Optimize for</label>
              <select style={inputStyle} value={optimizeMode} onChange={(e) => setOptimizeMode(e.target.value as 'fastest' | 'fewest')}>
                <option value="fastest">Fastest completion (use all vehicles)</option>
                <option value="fewest">Fewest vehicles (consolidate)</option>
              </select>
              <div style={{ fontSize: '11px', color: 'var(--text-secondary, #6b7280)', marginTop: 4 }}>
                {optimizeMode === 'fastest'
                  ? 'Splits pickups across all vehicles so they run in parallel - lowest completion time, more total km.'
                  : 'Packs vehicles full to minimise total driving - fewer, longer trips and a higher completion time.'}
              </div>
            </div>
            <button style={btn(!busy)} disabled={busy} onClick={solve}>{busy ? (notice ? 'Working…' : 'Solving…') : '4 · Plan evacuation'}</button>
          </>
        )}

        {planStats && (
          <>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
              <Kpi label="Evacuees" value={planStats.evacuees} />
              <Kpi label="Evacuated" value={planStats.assigned} color="#16a34a" />
              <Kpi label="Trips" value={planStats.trips} />
              <Kpi label="Completion (min)" value={planStats.completionMin} color="#2563eb" />
            </div>
            <div style={{ fontSize: '11px', color: 'var(--text-secondary, #6b7280)' }}>
              Completion = when the last vehicle finishes (vehicles run in parallel). Total drive across all vehicles: {planStats.totalMin} min.
            </div>
            {planStats.splitForSpeed && (
              <div style={{ fontSize: '11px', color: 'var(--text-secondary, #6b7280)' }}>
                Fastest mode: trips capped at {planStats.tripCap} stop(s) so all vehicles run in parallel.
              </div>
            )}
            {planStats.autoTrips > 0 && (
              <div style={{ fontSize: '11px', color: 'var(--text-secondary, #6b7280)' }}>
                Raised to {planStats.autoTrips} trips/vehicle to seat every evacuee.
              </div>
            )}
            {planStats.overflow > 0 && (
              <div style={{ fontSize: '11px', color: '#b45309', background: '#fef3c7', padding: '8px 10px', borderRadius: 6 }}>
                {planStats.overflow} participant(s) could not be seated within {depotCount} center(s) &times; {numVehicles} vehicle(s) &times; {capacity} capacity &times; {CEIL_TRIPS} max trips. Add vehicles/center or capacity. They are ringed in red on the map.
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
        {notice && <div style={{ padding: '10px', borderRadius: '6px', backgroundColor: 'var(--surface-info, #eff6ff)', border: '1px solid var(--border-info, #bfdbfe)', fontSize: '12px', color: 'var(--text-info, #1d4ed8)' }}>{notice}</div>}
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

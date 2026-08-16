'use client';

// Tier-3 showcase: Backload Matching Engine (neutral, industry-agnostic).
//
// Loads idle/returning trailers, waiting internal loads, and external freight
// offers from the FLEET_APP.BACKLOAD_MATCHING pack views, builds a VROOM
// challenge (trailers as capacitated vehicles anchored at their idle drop-off
// and ending at home; internal + external loads as shipments, internal ranked
// first via priority), solves it through /api/backload/solve (the neutral
// ROUTING_PLATFORM.CONTRACT seam), and renders the proposed backhaul tours as
// assignment cards, KPIs, and a deck.gl map. Dispatchers can write accepted
// matches back to the PROPOSAL_DECISIONS audit table and request a Cortex
// rationale. No third-party / vendor branding anywhere.

import { useCallback, useEffect, useMemo, useState } from 'react';
import { RouteMapInline } from '@/components/inline/route-map-inline';
import { useAppStore } from '@/lib/store';

const COST_SCALE = 100; // currency -> VROOM integer cost units
const USD_PER_LOADED_KM = 1.2;

interface Trailer {
  TRAILER_ID: string; OPERATING_COUNTRY: string; HOME_DEPOT: string;
  HOME_LON: number; HOME_LAT: number; CURRENT_LOAD: string;
  DROPOFF_CITY: string; DROPOFF_LON: number; DROPOFF_LAT: number;
  ETA_MIN: number; STATUS: string; HAZMAT_CERT: boolean; MAX_PAYLOAD_KG: number;
}
interface Volume {
  ID: string; PICKUP_CITY: string; PICKUP_LON: number; PICKUP_LAT: number;
  DROPOFF_CITY: string; DROPOFF_LON: number; DROPOFF_LAT: number;
  WEIGHT_KG: number; PRODUCT: string; HAZMAT: boolean;
}
interface Offer extends Volume { OFFER_ID: string; SOURCE: string; PRICE_USD: number; LISTING_TEXT: string; }
interface VehicleClass {
  VEHICLE_TYPE: string; ORS_PROFILE: string; PAYLOAD_KG_TYP: number;
  SHIPMENT_KG_MIN: number; SHIPMENT_KG_MAX: number; AVG_SPEED_KMH: number;
  COST_PER_KM: number; COST_PER_HR: number; HOME_RANGE_KM: number; LABEL_NOUN: string;
}
interface Assignment {
  id: string; trailerId: string; offerId: string; source: string;
  pickupLon: number; pickupLat: number; dropoffLon: number; dropoffLat: number;
  trailerLon: number; trailerLat: number;
  emptyKm: number; loadedKm: number; nDeliveries: number;
  revenueUsd: number; costUsd: number; netBenefitUsd: number; score: number;
  product: string; pickupCity: string; dropoffCity: string;
}

function haversineKm(lon1: number, lat1: number, lon2: number, lat2: number): number {
  const R = 6371, toRad = (x: number) => (x * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1), dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

async function sfRead(sql: string): Promise<Record<string, unknown>[]> {
  const res = await fetch('/api/query', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sql }),
  });
  const body = await res.json();
  if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
  // /api/query returns column keys lowercased; normalize to UPPERCASE so the
  // view's uppercase field access (t.DROPOFF_LON etc.) resolves. Without this,
  // coords read as undefined -> NaN -> VROOM "Invalid start array".
  const rows = (body.rows as Record<string, unknown>[]) || [];
  return rows.map((r) => {
    const o: Record<string, unknown> = {};
    for (const k of Object.keys(r)) o[k.toUpperCase()] = r[k];
    return o;
  });
}

const BM = 'FLEET_APP.BACKLOAD_MATCHING';

export function BackloadMatchingView() {
  const region = useAppStore((s) => s.context['region']) as string | undefined;

  const [cfg, setCfg] = useState<{ vehicleType: string; region: string } | null>(null);
  const [cls, setCls] = useState<VehicleClass | null>(null);
  const [trailers, setTrailers] = useState<Trailer[]>([]);
  const [internal, setInternal] = useState<Volume[]>([]);
  const [external, setExternal] = useState<Offer[]>([]);
  const [loadErr, setLoadErr] = useState<string | null>(null);

  // Solver controls (the "full matcher" knobs).
  const [maxVehicles, setMaxVehicles] = useState(8);
  const [maxInternal, setMaxInternal] = useState(40);
  const [maxExternal, setMaxExternal] = useState(60);
  const [maxStops, setMaxStops] = useState(2);
  const [detourSlackHrs, setDetourSlackHrs] = useState(4);
  const [deviationPct, setDeviationPct] = useState(200);
  const [internalFirstWeight, setInternalFirstWeight] = useState(90);

  const [solving, setSolving] = useState(false);
  const [solveError, setSolveError] = useState<string | null>(null);
  const [assignments, setAssignments] = useState<Assignment[]>([]);
  const [unassigned, setUnassigned] = useState<{ id: number; reason?: string }[]>([]);
  const [confirmMsg, setConfirmMsg] = useState<string | null>(null);
  const [rationale, setRationale] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setLoadErr(null);
    try {
      const cfgRows = await sfRead(`SELECT VEHICLE_TYPE, REGION FROM ${BM}.VW_CONFIG LIMIT 1`);
      const c = cfgRows[0] as { VEHICLE_TYPE?: string; REGION?: string } | undefined;
      const vehicleType = String(c?.VEHICLE_TYPE ?? 'hgv');
      const cfgRegion = String(c?.REGION ?? region ?? 'SanFrancisco');
      setCfg({ vehicleType, region: cfgRegion });

      const [clsRows, tRows, iRows, oRows] = await Promise.all([
        sfRead(`SELECT * FROM ${BM}.VW_VEHICLE_CLASS WHERE VEHICLE_TYPE = '${vehicleType.replace(/'/g, "''")}' LIMIT 1`),
        sfRead(`SELECT * FROM ${BM}.VW_TRAILERS`),
        sfRead(`SELECT * FROM ${BM}.VW_INTERNAL_VOLUMES`),
        sfRead(`SELECT * FROM ${BM}.VW_EXTERNAL_OFFERS`),
      ]);
      setCls((clsRows[0] as unknown as VehicleClass) ?? null);
      setTrailers(tRows as unknown as Trailer[]);
      setInternal(iRows as unknown as Volume[]);
      setExternal(oRows as unknown as Offer[]);
    } catch (e) {
      setLoadErr(e instanceof Error ? e.message : 'Failed to load backload data');
    }
  }, [region]);

  useEffect(() => { load(); }, [load]);

  const solve = useCallback(async () => {
    if (!cls || !cfg) return;
    setSolving(true);
    setSolveError(null);
    setAssignments([]);
    setUnassigned([]);
    setConfirmMsg(null);
    setRationale(null);

    const profile = cls.ORS_PROFILE;
    const speedKmh = cls.AVG_SPEED_KMH || 50;
    const classCapacityKg = cls.PAYLOAD_KG_TYP || 1000;
    const effPerKm = cls.COST_PER_KM || 0.85;
    const fixedDispatch = 120;

    const trailerById = new Map<number, Trailer>();
    const vrpVehicles = trailers.slice(0, maxVehicles).map((t, i) => {
      const id = i + 1;
      trailerById.set(id, t);
      const hasHome = Number.isFinite(Number(t.HOME_LON)) && Number.isFinite(Number(t.HOME_LAT));
      const emptyKm = hasHome
        ? haversineKm(Number(t.DROPOFF_LON), Number(t.DROPOFF_LAT), Number(t.HOME_LON), Number(t.HOME_LAT))
        : cls.HOME_RANGE_KM;
      const baseDurSec = Math.round((emptyKm / speedKmh) * 3600);
      const baseDistM = Math.round(emptyKm * 1000);
      const veh: Record<string, unknown> = {
        id, profile,
        start: [Number(t.DROPOFF_LON), Number(t.DROPOFF_LAT)],
        capacity: [Number(t.MAX_PAYLOAD_KG) || classCapacityKg],
        skills: t.HAZMAT_CERT ? [1, 2, 3] : [1, 2],
        max_tasks: maxStops,
        max_travel_time: Math.max(1800, baseDurSec + Math.round(detourSlackHrs * 3600)),
        max_distance: Math.max(10000, Math.round(baseDistM * (1 + deviationPct / 100))),
        costs: { fixed: Math.round(fixedDispatch * COST_SCALE), per_km: Math.round(effPerKm * COST_SCALE) },
      };
      if (hasHome) veh.end = [Number(t.HOME_LON), Number(t.HOME_LAT)];
      return veh;
    });

    const offerById = new Map<number, { kind: 'INTERNAL' | 'EXTERNAL'; row: Volume | Offer }>();
    let nextId = 1000;
    const vrpShipments: Record<string, unknown>[] = [];
    for (const v of internal.slice(0, maxInternal)) {
      const id = nextId++;
      offerById.set(id, { kind: 'INTERNAL', row: v });
      const kg = Math.min(Number(v.WEIGHT_KG), classCapacityKg);
      vrpShipments.push({
        pickup: { id, location: [Number(v.PICKUP_LON), Number(v.PICKUP_LAT)], service: 1800 },
        delivery: { id, location: [Number(v.DROPOFF_LON), Number(v.DROPOFF_LAT)], service: 600 },
        amount: [kg], skills: v.HAZMAT ? [1, 3] : [1], priority: internalFirstWeight,
      });
    }
    for (const o of external.slice(0, maxExternal)) {
      const id = nextId++;
      offerById.set(id, { kind: 'EXTERNAL', row: o });
      const kg = Math.min(Number(o.WEIGHT_KG), classCapacityKg);
      vrpShipments.push({
        pickup: { id, location: [Number(o.PICKUP_LON), Number(o.PICKUP_LAT)], service: 1800 },
        delivery: { id, location: [Number(o.DROPOFF_LON), Number(o.DROPOFF_LAT)], service: 600 },
        amount: [kg], skills: o.HAZMAT ? [2, 3] : [2], priority: Math.max(0, 100 - internalFirstWeight),
      });
    }

    if (!vrpVehicles.length || !vrpShipments.length) {
      setSolveError('No trailers or loads available for the active preset.');
      setSolving(false);
      return;
    }

    // Let the routing gateway pre-compute the matrix (options.g=true).
    const challenge = { vehicles: vrpVehicles, shipments: vrpShipments, options: { g: true } };

    let respObj: Record<string, unknown> | null = null;
    try {
      const res = await fetch('/api/backload/solve', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ challenge, region: cfg.region }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
      respObj = body.result as Record<string, unknown>;
    } catch (e) {
      setSolveError(e instanceof Error ? e.message : 'Solve failed');
      setSolving(false);
      return;
    }

    const routes = Array.isArray(respObj?.routes) ? (respObj!.routes as Record<string, unknown>[]) : [];
    const un = Array.isArray(respObj?.unassigned) ? (respObj!.unassigned as Record<string, unknown>[]) : [];
    setUnassigned(un.map((u) => ({ id: Number(u.id), reason: String(u.description ?? u.type ?? '') })));

    const out: Assignment[] = [];
    for (const route of routes) {
      const vehId = Number(route.vehicle);
      const t = trailerById.get(vehId);
      if (!t) continue;
      const steps = Array.isArray(route.steps) ? (route.steps as Record<string, unknown>[]) : [];
      const taskSteps = steps.filter((s) => s.type === 'pickup' || s.type === 'delivery' || s.type === 'job');
      const firstPick = taskSteps.find((s) => s.type === 'pickup' || s.type === 'job');
      if (!firstPick) continue;
      const ent = offerById.get(Number(firstPick.id ?? firstPick.job));
      if (!ent) continue;
      const row = ent.row as Offer;
      const empty = haversineKm(Number(t.DROPOFF_LON), Number(t.DROPOFF_LAT), Number(row.PICKUP_LON), Number(row.PICKUP_LAT));
      const loaded = haversineKm(Number(row.PICKUP_LON), Number(row.PICKUP_LAT), Number(row.DROPOFF_LON), Number(row.DROPOFF_LAT));
      const nDeliveries = taskSteps.filter((s) => s.type === 'delivery' || s.type === 'job').length || 1;
      const revenue = ent.kind === 'EXTERNAL' && Number.isFinite(Number((row as Offer).PRICE_USD))
        ? Number((row as Offer).PRICE_USD)
        : loaded * USD_PER_LOADED_KM;
      const cost = (empty + loaded) * effPerKm + fixedDispatch;
      const net = revenue - cost;
      out.push({
        id: `${t.TRAILER_ID}__${ent.kind === 'INTERNAL' ? (row as Volume).ID : (row as Offer).OFFER_ID}`,
        trailerId: t.TRAILER_ID,
        offerId: ent.kind === 'INTERNAL' ? (row as Volume).ID : (row as Offer).OFFER_ID,
        source: ent.kind === 'INTERNAL' ? 'INTERNAL' : (row as Offer).SOURCE,
        pickupLon: Number(row.PICKUP_LON), pickupLat: Number(row.PICKUP_LAT),
        dropoffLon: Number(row.DROPOFF_LON), dropoffLat: Number(row.DROPOFF_LAT),
        trailerLon: Number(t.DROPOFF_LON), trailerLat: Number(t.DROPOFF_LAT),
        emptyKm: empty, loadedKm: loaded, nDeliveries,
        revenueUsd: revenue, costUsd: cost, netBenefitUsd: net,
        score: Math.round(Math.max(0, 100 - empty)),
        product: row.PRODUCT, pickupCity: row.PICKUP_CITY, dropoffCity: row.DROPOFF_CITY,
      });
    }
    out.sort((a, b) => b.netBenefitUsd - a.netBenefitUsd);
    setAssignments(out);
    if (!out.length && !un.length) setSolveError('Solver returned no routes. Try raising Detour budget or Deviation %.');
    setSolving(false);
  }, [cls, cfg, trailers, internal, external, maxVehicles, maxInternal, maxExternal, maxStops, detourSlackHrs, deviationPct, internalFirstWeight]);

  // Build a GeoJSON FeatureCollection (empty + loaded legs, points) for the map.
  const mapResult = useMemo(() => {
    const features: GeoJSON.Feature[] = [];
    for (const a of assignments) {
      features.push({ type: 'Feature', properties: { leg: 'empty', trailer: a.trailerId }, geometry: { type: 'LineString', coordinates: [[a.trailerLon, a.trailerLat], [a.pickupLon, a.pickupLat]] } });
      features.push({ type: 'Feature', properties: { leg: 'loaded', offer: a.offerId }, geometry: { type: 'LineString', coordinates: [[a.pickupLon, a.pickupLat], [a.dropoffLon, a.dropoffLat]] } });
      features.push({ type: 'Feature', properties: { kind: 'pickup', city: a.pickupCity }, geometry: { type: 'Point', coordinates: [a.pickupLon, a.pickupLat] } });
      features.push({ type: 'Feature', properties: { kind: 'trailer', id: a.trailerId }, geometry: { type: 'Point', coordinates: [a.trailerLon, a.trailerLat] } });
    }
    return { type: 'FeatureCollection', features } as GeoJSON.FeatureCollection;
  }, [assignments]);

  const kpis = useMemo(() => {
    const n = assignments.length;
    const totalEmpty = assignments.reduce((s, a) => s + a.emptyKm, 0);
    const totalNet = assignments.reduce((s, a) => s + a.netBenefitUsd, 0);
    const nInternal = assignments.filter((a) => a.source === 'INTERNAL').length;
    return { n, totalEmpty, totalNet, nInternal };
  }, [assignments]);

  const writeDecisions = useCallback(async () => {
    if (!assignments.length) return;
    setBusy(true); setConfirmMsg(null);
    try {
      const res = await fetch('/api/backload/decide', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          decisions: assignments.map((a) => ({
            trailerId: a.trailerId, offerId: a.offerId, source: a.source,
            score: a.score, emptyKm: Number(a.emptyKm.toFixed(1)),
            netBenefitUsd: Number(a.netBenefitUsd.toFixed(2)), rationale: rationale ?? undefined,
          })),
        }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
      setConfirmMsg(`Wrote ${body.written} decisions to PROPOSAL_DECISIONS.`);
    } catch (e) {
      setConfirmMsg(e instanceof Error ? e.message : 'Write failed');
    } finally { setBusy(false); }
  }, [assignments, rationale]);

  const explain = useCallback(async () => {
    if (!assignments.length) return;
    setBusy(true);
    try {
      const top = assignments.slice(0, 8).map((a) =>
        `${a.trailerId} -> ${a.offerId} (${a.source}, empty ${a.emptyKm.toFixed(0)}km, net $${a.netBenefitUsd.toFixed(0)})`).join('; ');
      const prompt = `You are a fleet dispatcher. In 3 short sentences, explain why these backload matches reduce empty miles and improve margin: ${top}`.replace(/'/g, "''");
      const rows = await sfRead(`SELECT SNOWFLAKE.CORTEX.COMPLETE('claude-sonnet-4-5', '${prompt}') AS R`);
      setRationale(String((rows[0] as { R?: string })?.R ?? '').trim());
    } catch (e) {
      setRationale(e instanceof Error ? e.message : 'Rationale unavailable');
    } finally { setBusy(false); }
  }, [assignments]);

  const label = { fontSize: 11, fontWeight: 600, color: 'var(--text-secondary, #6b7280)', textTransform: 'uppercase' as const, marginBottom: 2, display: 'block' };
  const card: React.CSSProperties = { padding: 12, borderRadius: 8, border: '1px solid var(--border-default, #e5e7eb)', backgroundColor: 'var(--surface-primary, #fff)' };
  const btn = (enabled: boolean): React.CSSProperties => ({ padding: '8px 16px', fontSize: 13, fontWeight: 600, borderRadius: 6, border: 'none', cursor: enabled ? 'pointer' : 'not-allowed', backgroundColor: 'var(--surface-accent-strong, #2563eb)', color: '#fff', opacity: enabled ? 1 : 0.6 });

  const slider = (lbl: string, val: number, set: (n: number) => void, min: number, max: number, step = 1, suffix = '') => (
    <div>
      <label style={label}>{lbl}: {val}{suffix}</label>
      <input type="range" min={min} max={max} step={step} value={val} onChange={(e) => set(Number(e.target.value))} style={{ width: '100%' }} />
    </div>
  );

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16, padding: 16, height: '100%', overflow: 'auto' }}>
      <div>
        <h2 style={{ fontSize: 16, fontWeight: 700, margin: '0 0 4px' }}>Backload Matching Engine</h2>
        <p style={{ fontSize: 13, color: 'var(--text-secondary, #6b7280)', margin: 0 }}>
          Fill empty return legs by matching idle {cls?.LABEL_NOUN ?? 'vehicles'} to waiting internal loads and external freight offers
          {cfg ? ` (${cfg.vehicleType} / ${cfg.region})` : ''}. Internal loads are ranked first.
        </p>
      </div>

      {loadErr && <div style={{ ...card, borderColor: 'var(--border-error, #fecaca)', backgroundColor: 'var(--surface-error, #fef2f2)', color: 'var(--text-error, #dc2626)', fontSize: 13 }}>{loadErr}</div>}

      <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', fontSize: 12, color: 'var(--text-secondary, #6b7280)' }}>
        <span><strong>{trailers.length}</strong> trailers</span>
        <span><strong>{internal.length}</strong> internal loads</span>
        <span><strong>{external.length}</strong> external offers</span>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 12 }}>
        {slider('Max trailers', maxVehicles, setMaxVehicles, 1, Math.max(1, trailers.length))}
        {slider('Max internal loads', maxInternal, setMaxInternal, 0, Math.max(1, internal.length))}
        {slider('Max external offers', maxExternal, setMaxExternal, 0, Math.max(1, external.length))}
        {slider('Max stops / trailer', maxStops, setMaxStops, 1, 6)}
        {slider('Detour budget', detourSlackHrs, setDetourSlackHrs, 0, 12, 1, ' h')}
        {slider('Allowed deviation', deviationPct, setDeviationPct, 0, 400, 10, ' %')}
        {slider('Internal-first weight', internalFirstWeight, setInternalFirstWeight, 0, 100)}
      </div>

      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        <button onClick={solve} disabled={solving || !cls} style={btn(!solving && !!cls)}>
          {solving ? 'Solving…' : 'Match backloads'}
        </button>
        <button onClick={writeDecisions} disabled={busy || !assignments.length} style={btn(!busy && !!assignments.length)}>
          Accept & write decisions
        </button>
        <button onClick={explain} disabled={busy || !assignments.length} style={btn(!busy && !!assignments.length)}>
          Explain (Cortex)
        </button>
      </div>

      {solveError && <div style={{ ...card, borderColor: 'var(--border-error, #fecaca)', backgroundColor: 'var(--surface-error, #fef2f2)', color: 'var(--text-error, #dc2626)', fontSize: 13 }}>{solveError}</div>}
      {confirmMsg && <div style={{ ...card, fontSize: 13, color: 'var(--text-primary, #111827)' }}>{confirmMsg}</div>}

      {assignments.length > 0 && (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 12 }}>
          <div style={card}><div style={label}>Matches</div><div style={{ fontSize: 22, fontWeight: 700 }}>{kpis.n}</div></div>
          <div style={card}><div style={label}>Internal filled</div><div style={{ fontSize: 22, fontWeight: 700 }}>{kpis.nInternal}</div></div>
          <div style={card}><div style={label}>Empty km</div><div style={{ fontSize: 22, fontWeight: 700 }}>{kpis.totalEmpty.toFixed(0)}</div></div>
          <div style={card}><div style={label}>Net benefit</div><div style={{ fontSize: 22, fontWeight: 700 }}>${kpis.totalNet.toFixed(0)}</div></div>
        </div>
      )}

      {rationale && <div style={{ ...card, fontSize: 13, lineHeight: 1.5 }}>{rationale}</div>}

      {assignments.length > 0 && <RouteMapInline result={mapResult} />}

      {assignments.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {assignments.map((a) => (
            <div key={a.id} style={{ ...card, display: 'flex', justifyContent: 'space-between', gap: 12, fontSize: 13 }}>
              <div>
                <strong>{a.trailerId}</strong> &rarr; {a.offerId}
                <span style={{ marginLeft: 8, padding: '1px 6px', borderRadius: 4, fontSize: 11, backgroundColor: a.source === 'INTERNAL' ? 'var(--surface-accent, #dbeafe)' : 'var(--surface-secondary, #f3f4f6)' }}>{a.source}</span>
                <div style={{ color: 'var(--text-secondary, #6b7280)', fontSize: 12 }}>{a.pickupCity} &rarr; {a.dropoffCity} · {a.product}</div>
              </div>
              <div style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
                <div>empty {a.emptyKm.toFixed(0)} km · loaded {a.loadedKm.toFixed(0)} km</div>
                <div style={{ fontWeight: 600, color: a.netBenefitUsd >= 0 ? 'var(--text-success, #16a34a)' : 'var(--text-error, #dc2626)' }}>net ${a.netBenefitUsd.toFixed(0)}</div>
              </div>
            </div>
          ))}
        </div>
      )}

      {unassigned.length > 0 && (
        <div style={{ ...card, fontSize: 12, color: 'var(--text-secondary, #6b7280)' }}>
          <strong>{unassigned.length}</strong> loads unassigned{unassigned[0]?.reason ? ` (e.g. ${unassigned[0].reason})` : ''}.
        </div>
      )}
    </div>
  );
}

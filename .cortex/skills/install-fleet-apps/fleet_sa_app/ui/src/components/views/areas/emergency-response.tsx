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

import { useCallback, useEffect, useMemo, useState } from 'react';
import { GeoJsonLayer, ScatterplotLayer } from '@deck.gl/layers';
import type { Layer } from '@deck.gl/core';
import MapView from './map-view';
import { useAppStore } from '@/lib/store';
import type { LngLat } from '@/lib/map/map-fit';

type Hazard = 'WILDFIRE' | 'FLOOD';
interface County { county: string; geojson: string; wildfire_level: number; flood_level: number; }
interface CareCenter { center_id: string; center_name: string; lon: number; lat: number; }
interface Participant { pid: string; lon: number; lat: number; county: string | null; lvl: number; lbl: string; }

// Risk ramp 0..5 -> grey, green, lime, yellow, orange, red.
const RISK_RGB: [number, number, number][] = [
  [148, 163, 184], [34, 197, 94], [132, 204, 22], [234, 179, 8], [249, 115, 22], [220, 38, 38],
];
const riskColor = (lvl: number): [number, number, number] => RISK_RGB[Math.max(0, Math.min(5, Math.round(lvl || 0)))];

async function apiQuery(sql: string, params?: Record<string, string | null>): Promise<Record<string, unknown>[]> {
  const res = await fetch('/api/query', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sql, params }),
  });
  const body = await res.json();
  if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
  return (body.rows as Record<string, unknown>[]) || [];
}

async function apiTool(verb: string, args: unknown[]): Promise<Record<string, unknown>> {
  const res = await fetch('/api/tool', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ verb, args }),
  });
  const body = await res.json();
  if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
  // The synapse envelope nests the proc output under result.result; unwrap one
  // level when present so callers read { status, participants, ... } directly.
  const r = body.result as Record<string, unknown> | null;
  if (r && typeof r === 'object' && 'result' in r && r.result && typeof r.result === 'object') {
    return r.result as Record<string, unknown>;
  }
  return r || {};
}

const ER = 'FLEET_APP.EMERGENCY_RESPONSE';

export function EmergencyResponseView() {
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
  const [routeGeo, setRouteGeo] = useState<GeoJSON.FeatureCollection | null>(null);
  const [summary, setSummary] = useState<Record<string, unknown> | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Availability + Step 1 data load whenever the active region changes.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      setAvail('checking'); setError(null);
      setStep(1); setParticipants([]); setUnionGeo(null); setRouteGeo(null); setSummary(null);
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
    setBusy(true); setError(null); setRouteGeo(null); setSummary(null);
    try {
      const r = await apiTool('evac_seed', [region ?? null, hazard, minutes, targetCount]);
      if (r.status !== 'SUCCESS') throw new Error(String(r.error || 'Seeding failed'));
      setUnionGeo((r.union_geojson as GeoJSON.Geometry) ?? null);
      setParticipants((r.participants as Participant[]) ?? []);
      setStep(3);
    } catch (e) { setError(e instanceof Error ? e.message : 'Seeding failed'); }
    finally { setBusy(false); }
  }, [region, hazard, minutes, targetCount]);

  const solve = useCallback(async () => {
    setBusy(true); setError(null);
    try {
      // Multi-depot, multi-trip: round-robin vans across care centers; expand
      // each van into up to maxTrips virtual vehicles. Each participant = a
      // pickup:[1] job. Capacity bounds people per trip.
      const depots = centers.slice(0, Math.max(1, numVehicles));
      const vehicles: unknown[] = [];
      let vid = 1;
      for (let v = 0; v < numVehicles; v++) {
        const d = depots[v % depots.length] || depots[0];
        for (let t = 0; t < maxTrips; t++) {
          vehicles.push({ id: vid++, start: [d.lon, d.lat], end: [d.lon, d.lat], profile: 'driving-car', capacity: [capacity] });
        }
      }
      const jobs = participants.map((p, i) => ({ id: i + 1, location: [p.lon, p.lat], pickup: [1], description: p.pid }));
      const challenge = JSON.stringify({ vehicles, jobs });
      const r = await apiTool('evac_solve', [challenge, region ?? null]);
      if (r.status !== 'SUCCESS') throw new Error(String(r.error || 'Solve failed'));
      const geo = r.geometry as GeoJSON.FeatureCollection | GeoJSON.Geometry | null;
      const fc: GeoJSON.FeatureCollection = geo && (geo as GeoJSON.FeatureCollection).type === 'FeatureCollection'
        ? (geo as GeoJSON.FeatureCollection)
        : { type: 'FeatureCollection', features: geo ? [{ type: 'Feature', geometry: geo as GeoJSON.Geometry, properties: {} }] : [] };
      setRouteGeo(fc);
      setSummary((r.summary as Record<string, unknown>) ?? {});
      setStep(4);
    } catch (e) { setError(e instanceof Error ? e.message : 'Solve failed'); }
    finally { setBusy(false); }
  }, [centers, numVehicles, maxTrips, capacity, participants, region]);

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
        stroked: true, filled: true, getFillColor: (f: any) => [...riskColor(f.properties.lvl), 90] as any,
        getLineColor: [120, 120, 120], lineWidthMinPixels: 1, pickable: true,
      }));
    }
    if (unionGeo) {
      out.push(new GeoJsonLayer({
        id: 'iso-union', data: { type: 'Feature', geometry: unionGeo, properties: {} } as any,
        stroked: true, filled: true, getFillColor: [37, 99, 235, 40], getLineColor: [37, 99, 235], lineWidthMinPixels: 2,
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
        getFillColor: (d: Participant) => [...riskColor(d.lvl), 220] as any, getRadius: 30,
        radiusMinPixels: 3, radiusMaxPixels: 7, pickable: true,
      }));
    }
    if (routeGeo) {
      out.push(new GeoJsonLayer({
        id: 'routes', data: routeGeo, stroked: true, filled: false,
        getLineColor: [37, 99, 235], lineWidthMinPixels: 3,
      }));
    }
    return out;
  }, [counties, hazard, unionGeo, centers, participants, routeGeo]);

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
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: '10px' }}>
              <div><label style={labelStyle}>3 · Vans</label><input type="number" min={1} max={20} style={inputStyle} value={numVehicles} onChange={(e) => setNumVehicles(Number(e.target.value))} /></div>
              <div><label style={labelStyle}>Capacity</label><input type="number" min={1} max={20} style={inputStyle} value={capacity} onChange={(e) => setCapacity(Number(e.target.value))} /></div>
              <div><label style={labelStyle}>Max trips</label><input type="number" min={1} max={6} style={inputStyle} value={maxTrips} onChange={(e) => setMaxTrips(Number(e.target.value))} /></div>
            </div>
            <button style={btn(!busy)} disabled={busy} onClick={solve}>{busy ? 'Solving…' : '4 · Plan evacuation'}</button>
          </>
        )}

        {summary && (
          <div style={{ fontSize: '12px', color: 'var(--text-secondary, #6b7280)' }}>
            Routes: {(routeGeo?.features?.length ?? 0)} · Assigned all reachable participants.
          </div>
        )}
        {error && <div style={{ padding: '10px', borderRadius: '6px', backgroundColor: 'var(--surface-error, #fef2f2)', border: '1px solid var(--border-error, #fecaca)', fontSize: '12px', color: 'var(--text-error, #dc2626)' }}>{error}</div>}
      </div>

      <div style={{ position: 'relative', height: '100%' }}>
        <MapView layers={layers} fitTo={{ coords: fitCoords, focusKey: `${region}:${step}:${participants.length}` }}
          getTooltip={(info: any) => {
            const o = info?.object; if (!o) return null;
            if (o.center_name) return { text: o.center_name };
            if (o.pid) return { text: `${o.pid} · risk ${o.lbl ?? o.lvl}` };
            if (o.properties?.county) return { text: `${o.properties.county} · risk ${o.properties.lvl}` };
            return null;
          }} />
      </div>
    </div>
  );
}

// Emergency Response -- single-page evacuation planning wizard.
//
// Step 1  Pick hazard + state -> "Find risky areas" (ZIP risk choropleth)
// Step 2  #patients + drive minutes -> "Seed data" (centers + participants in
//         the union of per-center drive-time isochrones)
// Step 3  Per-center vehicle count + capacity
// Step 4  Pick risk threshold -> "Plan evacuation" (capacitated multi-depot VRP
//         over participants whose ZIP risk >= threshold)
//
// Fully client-driven via sfQuery; see helpers.ts.

import { useState, useEffect, useMemo, useCallback } from 'react';
import DeckGL from '@deck.gl/react';
import { ScatterplotLayer, GeoJsonLayer, PathLayer } from '@deck.gl/layers';
import { TileLayer } from '@deck.gl/geo-layers';
import { BitmapLayer } from '@deck.gl/layers';
import { useFitMap } from '../../shared/useFitMap';
import RecenterButton from '../../shared/RecenterButton';
import { coordsFromGeoJSON, type LngLat } from '../../shared/mapFit';
import { asSqlJsonLiteral } from '../../lib/sfQuery';
import {
  type Hazard, type StateOption, type RiskZip, type Center, type Participant,
  type VehicleConfig, type PlanRoute,
  RISK_RGBA, RISK_HEX, RISK_NAME,
  sfQuery, statesSql, orsStatusSql, riskZipsSql, centersSql, seedSql,
  nearestCenterId, buildVroomChallenge,
} from './helpers';

const CENTER_RGBA: [number, number, number, number] = [20, 90, 200, 255];
const ROUTE_PALETTE: [number, number, number][] = [
  [41, 128, 185], [142, 68, 173], [39, 174, 96], [211, 84, 0],
  [192, 57, 43], [22, 160, 133], [243, 156, 18], [127, 140, 141],
];

function cartoBasemap() {
  return new TileLayer({
    id: 'carto-basemap', data: '/api/tiles/{z}/{x}/{y}', minZoom: 0, maxZoom: 19, tileSize: 256,
    renderSubLayers: (props: any) => {
      const { boundingBox } = props.tile;
      return new BitmapLayer(props, { data: undefined, image: props.data, bounds: [boundingBox[0][0], boundingBox[0][1], boundingBox[1][0], boundingBox[1][1]] });
    },
  });
}

const STEPS = ['Risk areas', 'Seed data', 'Vehicles', 'Plan evacuation'];

export default function EmergencyResponse() {
  const [states, setStates] = useState<StateOption[]>([]);
  const [stateCode, setStateCode] = useState('');
  const [hazard, setHazard] = useState<Hazard>('wildfire');
  const [regionReady, setRegionReady] = useState<boolean | null>(null);

  const [step, setStep] = useState(1);
  const [riskZips, setRiskZips] = useState<RiskZip[]>([]);
  const [centers, setCenters] = useState<Center[]>([]);
  const [participants, setParticipants] = useState<Participant[]>([]);
  const [numPatients, setNumPatients] = useState(150);
  const [driveMinutes, setDriveMinutes] = useState(15);
  const [vehicleConfigs, setVehicleConfigs] = useState<Record<string, VehicleConfig>>({});
  const [riskThreshold, setRiskThreshold] = useState(4);
  const [routes, setRoutes] = useState<PlanRoute[]>([]);
  const [planStats, setPlanStats] = useState<{ evacuees: number; assigned: number; unassigned: number; totalMin: number } | null>(null);

  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  const activeState = states.find(s => s.stateCode === stateCode);
  const orsRegion = activeState?.orsRegion ?? '';

  // Load states once.
  useEffect(() => {
    (async () => {
      const rows = await sfQuery(statesSql(), 'EMERGENCY_RESPONSE', 'CONFIG');
      const opts: StateOption[] = rows.map((r: any) => ({
        stateCode: r.STATE_CODE, stateName: r.STATE_NAME, orsRegion: r.ORS_REGION, enabled: !!r.ENABLED,
      }));
      setStates(opts);
      if (opts.length && !stateCode) setStateCode(opts.find(o => o.enabled)?.stateCode || opts[0].stateCode);
    })();
  }, []);

  // Probe ORS readiness when the state changes.
  useEffect(() => {
    if (!orsRegion) { setRegionReady(null); return; }
    let cancelled = false;
    setRegionReady(null);
    (async () => {
      try {
        const rows = await sfQuery(orsStatusSql(orsRegion), 'OPENROUTESERVICE_APP', 'CORE');
        const raw = rows?.[0]?.S;
        const data = raw ? (typeof raw === 'string' ? JSON.parse(raw) : raw) : null;
        if (!cancelled) setRegionReady(!!data?.service_ready);
      } catch { if (!cancelled) setRegionReady(false); }
    })();
    return () => { cancelled = true; };
  }, [orsRegion]);

  // Reset downstream state when the scenario inputs change.
  const resetFromStep1 = () => {
    setCenters([]); setParticipants([]); setVehicleConfigs({});
    setRoutes([]); setPlanStats(null); setStep(1);
  };

  // ---- Step 1: Find risky areas -------------------------------------------
  const findRiskyAreas = useCallback(async () => {
    if (!stateCode) return;
    setBusy(true); setErr('');
    try {
      const rows = await sfQuery(riskZipsSql(stateCode, hazard), 'EMERGENCY_RESPONSE', 'PIPELINE', { throwOnError: true });
      const zips: RiskZip[] = rows.map((r: any) => ({
        zip: r.ZIP, level: Number(r.LEVEL) || 0, label: r.LABEL || 'No Rating',
        geojson: r.GEOJSON ? (typeof r.GEOJSON === 'string' ? JSON.parse(r.GEOJSON) : r.GEOJSON) : null,
      })).filter((z: RiskZip) => z.geojson);
      setRiskZips(zips);
      setParticipants([]); setCenters([]); setRoutes([]); setPlanStats(null);
      setStep(2);
    } catch (e: any) { setErr(`Risk lookup failed: ${e?.message || e}`); }
    finally { setBusy(false); }
  }, [stateCode, hazard]);

  // ---- Step 2: Seed data ---------------------------------------------------
  const seedData = useCallback(async () => {
    if (!stateCode || !orsRegion) return;
    setBusy(true); setErr('');
    try {
      const centerRows = await sfQuery(centersSql(stateCode), 'EMERGENCY_RESPONSE', 'CORE', { throwOnError: true });
      const cs: Center[] = centerRows.map((r: any) => ({
        centerId: r.CENTER_ID, name: r.CENTER_NAME, lon: Number(r.LON), lat: Number(r.LAT),
      }));
      if (!cs.length) throw new Error(`No InnovAge centers in ${stateCode}.`);
      setCenters(cs);

      const pRows = await sfQuery(seedSql(stateCode, orsRegion, hazard, numPatients, driveMinutes), 'EMERGENCY_RESPONSE', 'PIPELINE', { throwOnError: true });
      if (!pRows.length) throw new Error('No addresses found inside the drive-time area. Try a larger drive time.');
      const ps: Participant[] = pRows.map((r: any) => {
        const lon = Number(r.LON), lat = Number(r.LAT);
        return {
          id: String(r.PID), lon, lat, zip: String(r.ZIP || ''),
          riskLevel: Number(r.RISK_LEVEL) || 0, riskLabel: r.RISK_LABEL || 'No Rating',
          centerId: nearestCenterId(lon, lat, cs),
        };
      });
      setParticipants(ps);

      // Seed default vehicle config per center.
      const vc: Record<string, VehicleConfig> = {};
      for (const c of cs) vc[c.centerId] = { centerId: c.centerId, numVehicles: 2, capacity: 4 };
      setVehicleConfigs(vc);
      setRoutes([]); setPlanStats(null);
      setStep(3);
    } catch (e: any) { setErr(`Seed failed: ${e?.message || e}`); }
    finally { setBusy(false); }
  }, [stateCode, orsRegion, hazard, numPatients, driveMinutes]);

  // ---- Step 4: Plan evacuation --------------------------------------------
  const planEvacuation = useCallback(async () => {
    if (!orsRegion) return;
    const evacuees = participants.filter(p => p.riskLevel >= riskThreshold);
    if (!evacuees.length) { setErr(`No seeded participants fall in ZIPs at risk level >= ${riskThreshold}.`); return; }
    const configs = centers.map(c => vehicleConfigs[c.centerId]).filter(Boolean).filter(v => v.numVehicles > 0);
    if (!configs.length) { setErr('Assign at least one vehicle to a center.'); return; }
    setBusy(true); setErr('');
    try {
      const { challenge, vehicleCenter } = buildVroomChallenge(evacuees, centers, configs);
      const sql = `SELECT * FROM TABLE(OPENROUTESERVICE_APP.CORE.OPTIMIZATION(PARSE_JSON(${asSqlJsonLiteral(challenge)}), '${orsRegion.replace(/'/g, "''")}'))`;
      const rows = await sfQuery(sql, 'OPENROUTESERVICE_APP', 'CORE', { throwOnError: true });
      if (!rows.length) throw new Error('Solver returned no routes (VROOM service may be warming up; retry in ~20s).');
      const rs: PlanRoute[] = [];
      const assigned = new Set<number>();
      let totalSec = 0;
      for (const row of rows) {
        const vid = Number(row.VEHICLE) || 0;
        let geojson: any = null;
        try { geojson = row.GEOJSON ? (typeof row.GEOJSON === 'string' ? JSON.parse(row.GEOJSON) : row.GEOJSON) : null; } catch {}
        let steps: any[] = [];
        try { steps = typeof row.STEPS === 'string' ? JSON.parse(row.STEPS) : (row.STEPS || []); } catch {}
        const jobIds = steps.filter((s: any) => s.type === 'job' && s.id != null).map((s: any) => Number(s.id));
        jobIds.forEach(id => assigned.add(id));
        totalSec += Number(row.DURATION) || 0;
        rs.push({ vehicleId: vid, centerId: vehicleCenter[vid] || '', geojson, assignedJobIds: jobIds, durationSec: Number(row.DURATION) || 0 });
      }
      setRoutes(rs);
      setPlanStats({
        evacuees: evacuees.length,
        assigned: assigned.size,
        unassigned: evacuees.length - assigned.size,
        totalMin: Math.round(totalSec / 60),
      });
      setStep(4);
    } catch (e: any) { setErr(`Plan failed: ${e?.message || e}`); }
    finally { setBusy(false); }
  }, [orsRegion, participants, riskThreshold, centers, vehicleConfigs]);

  // ---- Map layers ----------------------------------------------------------
  const evacueeIds = useMemo(() => {
    if (step < 4) return new Set<string>();
    return new Set(participants.filter(p => p.riskLevel >= riskThreshold).map(p => p.id));
  }, [step, participants, riskThreshold]);

  const layers = useMemo(() => {
    const ls: any[] = [cartoBasemap()];

    if (riskZips.length) {
      ls.push(new GeoJsonLayer({
        id: 'risk-zips',
        data: { type: 'FeatureCollection', features: riskZips.map(z => ({ type: 'Feature', properties: { zip: z.zip, level: z.level, label: z.label }, geometry: z.geojson })) },
        stroked: true, filled: true, getFillColor: (f: any) => RISK_RGBA[f.properties.level] || RISK_RGBA[0],
        getLineColor: [255, 255, 255, 120], lineWidthMinPixels: 0.5, pickable: true,
        opacity: step === 1 ? 0.85 : 0.45,
      }));
    }
    if (participants.length) {
      ls.push(new ScatterplotLayer({
        id: 'participants', data: participants, getPosition: (d: Participant) => [d.lon, d.lat],
        getRadius: 40, radiusMinPixels: 2.2, radiusMaxPixels: 6,
        getFillColor: (d: Participant) => {
          if (step >= 4 && !evacueeIds.has(d.id)) return [150, 150, 150, 80];
          return RISK_RGBA[d.riskLevel] ? [RISK_RGBA[d.riskLevel][0], RISK_RGBA[d.riskLevel][1], RISK_RGBA[d.riskLevel][2], 220] : [120, 120, 120, 200];
        },
        pickable: true,
      }));
    }
    if (routes.length) {
      ls.push(new PathLayer({
        id: 'routes',
        data: routes.filter(r => r.geojson),
        getPath: (r: PlanRoute) => {
          const g = r.geojson;
          const coords = g?.type === 'LineString' ? g.coordinates : (g?.geometry?.coordinates || []);
          return coords;
        },
        getColor: (r: PlanRoute) => ROUTE_PALETTE[(r.vehicleId - 1) % ROUTE_PALETTE.length],
        widthMinPixels: 3, capRounded: true, jointRounded: true, pickable: true,
      }));
    }
    if (centers.length) {
      ls.push(new ScatterplotLayer({
        id: 'centers', data: centers, getPosition: (d: Center) => [d.lon, d.lat],
        getRadius: 160, radiusMinPixels: 7, radiusMaxPixels: 16,
        getFillColor: CENTER_RGBA, stroked: true, getLineColor: [255, 255, 255, 255], lineWidthMinPixels: 2,
        pickable: true,
      }));
    }
    return ls;
  }, [riskZips, participants, routes, centers, step, evacueeIds]);

  const fitCoords = useMemo<LngLat[]>(() => {
    if (participants.length) return participants.map(p => [p.lon, p.lat] as LngLat);
    if (riskZips.length) {
      const pts: LngLat[] = [];
      for (const z of riskZips.slice(0, 60)) pts.push(...coordsFromGeoJSON(z.geojson));
      return pts;
    }
    return [];
  }, [participants, riskZips]);

  const { containerRef, viewState, onViewStateChange, recenter } = useFitMap(fitCoords, { regionKey: `${stateCode}-${hazard}` });

  const getTooltip = useCallback(({ object, layer }: any) => {
    if (!object) return null;
    if (layer?.id === 'risk-zips') return { text: `ZIP ${object.properties.zip}\n${object.properties.label} (${object.properties.level})` };
    if (layer?.id === 'centers') return { text: object.name };
    if (layer?.id === 'participants') return { text: `${object.zip} -- ${object.riskLabel}` };
    return null;
  }, []);

  // ---- UI ------------------------------------------------------------------
  const panel: React.CSSProperties = { width: 340, minWidth: 340, padding: 16, overflow: 'auto', borderRight: '1px solid var(--border, #e2e2e2)' };
  const label: React.CSSProperties = { fontSize: 12, fontWeight: 600, color: 'var(--text-secondary,#555)', marginBottom: 4, display: 'block' };
  const inputStyle: React.CSSProperties = { width: '100%', padding: '6px 8px', borderRadius: 6, border: '1px solid var(--border,#ccc)', marginBottom: 12 };
  const btn = (primary: boolean): React.CSSProperties => ({
    width: '100%', padding: '9px 12px', borderRadius: 8, cursor: busy ? 'wait' : 'pointer',
    border: primary ? 'none' : '1px solid var(--border,#ccc)', background: primary ? 'var(--accent,#29b5e8)' : 'transparent',
    color: primary ? '#fff' : 'var(--text,#222)', fontWeight: 600, marginTop: 6,
  });

  return (
    <div style={{ display: 'flex', height: '100%' }}>
      <div style={panel}>
        <h2 style={{ margin: '0 0 4px', fontSize: 18 }}>Emergency Response</h2>
        <div style={{ fontSize: 12, color: 'var(--text-secondary,#777)', marginBottom: 12 }}>Evacuation planning for InnovAge PACE participants.</div>

        {/* Phase pips */}
        <div style={{ display: 'flex', gap: 4, marginBottom: 14 }}>
          {STEPS.map((s, i) => (
            <div key={s} style={{ flex: 1, textAlign: 'center', fontSize: 10, fontWeight: 600,
              color: step === i + 1 ? '#fff' : 'var(--text-secondary,#888)',
              background: step === i + 1 ? 'var(--accent,#29b5e8)' : 'var(--surface,#f1f1f1)',
              borderRadius: 6, padding: '5px 2px' }}>{i + 1}. {s}</div>
          ))}
        </div>

        {/* Step 1 */}
        <label style={label}>Disaster type</label>
        <select style={inputStyle} value={hazard} onChange={e => { setHazard(e.target.value as Hazard); resetFromStep1(); }}>
          <option value="wildfire">Wildfire</option>
          <option value="flood">Flood</option>
        </select>

        <label style={label}>State</label>
        <select style={inputStyle} value={stateCode} onChange={e => { setStateCode(e.target.value); setRiskZips([]); resetFromStep1(); }}>
          {states.map(s => <option key={s.stateCode} value={s.stateCode}>{s.stateName}{s.enabled ? '' : ' (disabled)'}</option>)}
        </select>
        {regionReady === false && (
          <div style={{ fontSize: 11, color: '#b45309', background: '#fef3c7', padding: '6px 8px', borderRadius: 6, marginBottom: 10 }}>
            ORS region <code>{orsRegion}</code> is not running. Resume it (Service Manager) before seeding or planning.
          </div>
        )}
        <button style={btn(true)} disabled={busy || !stateCode} onClick={findRiskyAreas}>
          {busy && step === 1 ? 'Working...' : 'Find risky areas'}
        </button>

        {/* Step 2 */}
        {step >= 2 && (
          <div style={{ marginTop: 18, paddingTop: 14, borderTop: '1px solid var(--border,#eee)' }}>
            <label style={label}>Patient locations to emulate</label>
            <input style={inputStyle} type="number" min={1} max={1000} value={numPatients} onChange={e => setNumPatients(Number(e.target.value))} />
            <label style={label}>Drive time from centers (minutes)</label>
            <input style={inputStyle} type="number" min={1} max={60} value={driveMinutes} onChange={e => setDriveMinutes(Number(e.target.value))} />
            <button style={btn(true)} disabled={busy || regionReady === false} onClick={seedData}>
              {busy && step === 2 ? 'Seeding...' : 'Seed data'}
            </button>
          </div>
        )}

        {/* Step 3 */}
        {step >= 3 && centers.length > 0 && (
          <div style={{ marginTop: 18, paddingTop: 14, borderTop: '1px solid var(--border,#eee)' }}>
            <label style={label}>Vehicles per center</label>
            <div style={{ fontSize: 11, color: 'var(--text-secondary,#888)', marginBottom: 6 }}>vehicles &times; capacity (passengers)</div>
            {centers.map(c => {
              const vc = vehicleConfigs[c.centerId] || { centerId: c.centerId, numVehicles: 0, capacity: 4 };
              return (
                <div key={c.centerId} style={{ marginBottom: 8 }}>
                  <div style={{ fontSize: 11, fontWeight: 600, marginBottom: 2 }}>{c.name.replace(/^InnovAge\s+/, '')}</div>
                  <div style={{ display: 'flex', gap: 6 }}>
                    <input style={{ ...inputStyle, marginBottom: 0 }} type="number" min={0} max={20} value={vc.numVehicles}
                      onChange={e => setVehicleConfigs(v => ({ ...v, [c.centerId]: { ...vc, numVehicles: Number(e.target.value) } }))} />
                    <input style={{ ...inputStyle, marginBottom: 0 }} type="number" min={1} max={30} value={vc.capacity}
                      onChange={e => setVehicleConfigs(v => ({ ...v, [c.centerId]: { ...vc, capacity: Number(e.target.value) } }))} />
                  </div>
                </div>
              );
            })}
          </div>
        )}

        {/* Step 4 */}
        {step >= 3 && participants.length > 0 && (
          <div style={{ marginTop: 18, paddingTop: 14, borderTop: '1px solid var(--border,#eee)' }}>
            <label style={label}>Evacuate risk level &gt;=</label>
            <select style={inputStyle} value={riskThreshold} onChange={e => setRiskThreshold(Number(e.target.value))}>
              {[1, 2, 3, 4, 5].map(l => <option key={l} value={l}>{l} -- {RISK_NAME[l]}</option>)}
            </select>
            <div style={{ fontSize: 11, color: 'var(--text-secondary,#888)', marginBottom: 6 }}>
              {participants.filter(p => p.riskLevel >= riskThreshold).length} of {participants.length} participants in scope
            </div>
            <button style={btn(true)} disabled={busy || regionReady === false} onClick={planEvacuation}>
              {busy && step >= 3 ? 'Solving...' : 'Plan evacuation'}
            </button>
          </div>
        )}

        {planStats && (
          <div style={{ marginTop: 16, display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
            <Kpi label="Evacuees" value={planStats.evacuees} />
            <Kpi label="Assigned" value={planStats.assigned} color="#26a65b" />
            <Kpi label="Unassigned" value={planStats.unassigned} color={planStats.unassigned ? '#c0392b' : undefined} />
            <Kpi label="Total drive (min)" value={planStats.totalMin} />
          </div>
        )}

        {err && <div style={{ marginTop: 14, fontSize: 12, color: '#b91c1c', background: '#fee2e2', padding: '8px 10px', borderRadius: 6 }}>{err}</div>}

        {/* Risk legend */}
        {riskZips.length > 0 && (
          <div style={{ marginTop: 16, fontSize: 11 }}>
            <div style={{ fontWeight: 600, marginBottom: 4 }}>Risk level</div>
            {[5, 4, 3, 2, 1, 0].map(l => (
              <div key={l} style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 2 }}>
                <span style={{ width: 12, height: 12, borderRadius: 2, background: RISK_HEX[l], display: 'inline-block' }} />
                <span>{l} -- {RISK_NAME[l]}</span>
              </div>
            ))}
          </div>
        )}
      </div>

      <div ref={containerRef} style={{ flex: 1, position: 'relative' }}>
        <DeckGL viewState={viewState} onViewStateChange={onViewStateChange} controller={true} layers={layers} getTooltip={getTooltip} />
        <RecenterButton onClick={recenter} />
      </div>
    </div>
  );
}

function Kpi({ label, value, color }: { label: string; value: number; color?: string }) {
  return (
    <div style={{ background: 'var(--surface,#f6f6f6)', borderRadius: 8, padding: '8px 10px' }}>
      <div style={{ fontSize: 10, color: 'var(--text-secondary,#888)' }}>{label}</div>
      <div style={{ fontSize: 20, fontWeight: 700, color: color || 'var(--text,#222)' }}>{value}</div>
    </div>
  );
}

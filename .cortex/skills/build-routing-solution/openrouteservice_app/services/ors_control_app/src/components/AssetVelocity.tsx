import { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import MetricCard from '../shared/MetricCard';
import DeckGL from '@deck.gl/react';
import { ScatterplotLayer, GeoJsonLayer } from '@deck.gl/layers';
import { BitmapLayer } from '@deck.gl/layers';
import { TileLayer } from '@deck.gl/geo-layers';
import { useRegion } from '../hooks/useRegion';

const RO_DB = 'FLEET_INTELLIGENCE';
const RO_SCHEMA = 'ROUTE_OPTIMIZATION';
const CARTO_LIGHT = '/api/tiles/{z}/{x}/{y}';

async function sfQuery(sql: string, database = RO_DB, schema = RO_SCHEMA): Promise<any[]> {
  try {
    const res = await fetch('/api/query', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sql, database, schema }) });
    const body = await res.json();
    const rows = Array.isArray(body) ? body : (body.result ?? []);
    return Array.isArray(rows) ? rows : [];
  } catch (err) {
    console.error('[sfQuery] Error:', err, 'SQL:', sql.slice(0, 300));
    return [];
  }
}

function cartoBasemap() {
  return new TileLayer({
    id: 'carto-basemap', data: CARTO_LIGHT, minZoom: 0, maxZoom: 19, tileSize: 256,
    renderSubLayers: (props: any) => {
      const { boundingBox } = props.tile;
      return new BitmapLayer(props, { data: undefined, image: props.data, bounds: [boundingBox[0][0], boundingBox[0][1], boundingBox[1][0], boundingBox[1][1]] });
    },
  });
}

const SEVERITY_COLOR: Record<string, [number, number, number]> = {
  CRITICAL: [220, 38, 38],
  WARNING: [245, 158, 11],
  WATCH: [251, 191, 36],
  OK: [34, 197, 94],
};

interface Trailer {
  VEHICLE_ID: string;
  REGION: string;
  LAST_LOCATION_NAME: string;
  LAST_LOCATION_TYPE: string;
  LAST_LNG: number;
  LAST_LAT: number;
  IDLE_SINCE: string;
  IDLE_HOURS: number;
  IDLE_DAYS: number;
  ASSIGNED_DISPATCHER: string;
  COST_OF_IDLENESS_USD: number;
  PROJECTED_SAVINGS_USD: number;
  IDLE_SEVERITY: string;
}

interface Terminal {
  TERMINAL_ID: string;
  TERMINAL_NAME: string;
  LOCATION_TYPE: string;
  TERMINAL_LAT: number;
  TERMINAL_LNG: number;
  OUTBOUND: number;
  INBOUND: number;
  NET_OUTBOUND_TRIPS: number;
  DEMAND_SCORE: number;
}

export default function AssetVelocity() {
  const { regionName, center, zoom } = useRegion();
  const [idleHourThreshold, setIdleHourThreshold] = useState(72);
  const [trailers, setTrailers] = useState<Trailer[]>([]);
  const [terminals, setTerminals] = useState<Terminal[]>([]);
  const [loading, setLoading] = useState(false);
  const [pipelineMissing, setPipelineMissing] = useState(false);
  const [rationale, setRationale] = useState<{ vehicleId: string; text: string } | null>(null);
  const [rationaleLoading, setRationaleLoading] = useState(false);
  const [solving, setSolving] = useState(false);
  const [routePaths, setRoutePaths] = useState<any[]>([]);
  const [vrpResult, setVrpResult] = useState<any>(null);
  const [sortBy, setSortBy] = useState<keyof Trailer>('COST_OF_IDLENESS_USD');
  const [viewState, setViewState] = useState({ longitude: center.lng || -122.4194, latitude: center.lat || 37.7749, zoom: zoom || 11, pitch: 0, bearing: 0 });
  const [selectedVehicleId, setSelectedVehicleId] = useState<string | null>(null);
  const [orsProfile, setOrsProfile] = useState<string>('driving-car');
  const [mapDims, setMapDims] = useState<{ width: number; height: number } | null>(null);
  const mapContainerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = mapContainerRef.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      const { width, height } = entries[0].contentRect;
      if (width > 0 && height > 0) setMapDims({ width: Math.round(width), height: Math.round(height) });
    });
    ro.observe(el);
    if (el.clientWidth > 0 && el.clientHeight > 0) setMapDims({ width: el.clientWidth, height: el.clientHeight });
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    const lng = Number(center.lng);
    const lat = Number(center.lat);
    const z = Number(zoom);
    if (Number.isFinite(lng) && Number.isFinite(lat) && Number.isFinite(z) && (lng !== 0 || lat !== 0)) {
      setViewState(prev => ({ ...prev, longitude: lng, latitude: lat, zoom: z }));
    }
    setRoutePaths([]);
    setVrpResult(null);
    setRationale(null);
    setSelectedVehicleId(null);
  }, [center.lng, center.lat, zoom, regionName]);

  const loadData = useCallback(async () => {
    setLoading(true);
    setPipelineMissing(false);
    const probe = await sfQuery(`SELECT 1 AS OK FROM FLEET_INTELLIGENCE.DWELL_ANALYSIS.DT_DWELL_ENRICHED LIMIT 1`, 'FLEET_INTELLIGENCE', 'DWELL_ANALYSIS');
    if (!probe.length) {
      setPipelineMissing(true);
      setLoading(false);
      return;
    }
    const trailerSql = `
      SELECT VEHICLE_ID, REGION, LAST_LOCATION_NAME, LAST_LOCATION_TYPE,
             LAST_LNG, LAST_LAT, IDLE_SINCE::STRING AS IDLE_SINCE,
             IDLE_HOURS, IDLE_DAYS, ASSIGNED_DISPATCHER,
             COST_OF_IDLENESS_USD, PROJECTED_SAVINGS_USD, IDLE_SEVERITY
      FROM VW_TRAILER_COST_OF_IDLENESS
      WHERE REGION = '${regionName}'
        AND IDLE_HOURS >= ${idleHourThreshold}
      ORDER BY COST_OF_IDLENESS_USD DESC
      LIMIT 200`;
    const terminalSql = `
      SELECT TERMINAL_ID, TERMINAL_NAME, LOCATION_TYPE, TERMINAL_LAT, TERMINAL_LNG,
             OUTBOUND, INBOUND, NET_OUTBOUND_TRIPS, DEMAND_SCORE
      FROM VW_LANE_DEMAND
      WHERE REGION = '${regionName}'
      ORDER BY DEMAND_SCORE DESC
      LIMIT 50`;
    const profileSql = `
      SELECT ORS_PROFILE
      FROM FLEET_INTELLIGENCE.CORE.GENERATION_JOBS
      WHERE REGION = '${regionName}'
        AND STATUS IN ('COMPLETED','STOPPED')
      ORDER BY STARTED_AT DESC
      LIMIT 1`;
    const [t, tm, pr] = await Promise.all([sfQuery(trailerSql), sfQuery(terminalSql), sfQuery(profileSql, 'FLEET_INTELLIGENCE', 'CORE')]);
    setTrailers(t as Trailer[]);
    setTerminals(tm as Terminal[]);
    setOrsProfile((pr[0]?.ORS_PROFILE as string) || 'driving-car');
    setLoading(false);
  }, [regionName, idleHourThreshold]);

  useEffect(() => { loadData(); }, [loadData]);

  const totals = useMemo(() => {
    const ghost = trailers.length;
    const cost = trailers.reduce((s, x) => s + Number(x.COST_OF_IDLENESS_USD || 0), 0);
    const projected = trailers.reduce((s, x) => s + Number(x.PROJECTED_SAVINGS_USD || 0), 0);
    const avgDays = ghost ? trailers.reduce((s, x) => s + Number(x.IDLE_DAYS || 0), 0) / ghost : 0;
    return { ghost, cost, projected, avgDays };
  }, [trailers]);

  const sortedTrailers = useMemo(() => {
    return [...trailers].sort((a, b) => {
      const av = a[sortBy] as any; const bv = b[sortBy] as any;
      if (typeof av === 'number') return Number(bv) - Number(av);
      return String(bv).localeCompare(String(av));
    });
  }, [trailers, sortBy]);

  const nearestTerminals = useCallback((lng: number, lat: number, n = 3): Terminal[] => {
    return [...terminals]
      .map(t => ({ ...t, _d: Math.hypot(t.TERMINAL_LNG - lng, t.TERMINAL_LAT - lat) }))
      .sort((a, b) => (a as any)._d - (b as any)._d)
      .slice(0, n);
  }, [terminals]);

  const focusTrailer = useCallback((tr: Trailer) => {
    setSelectedVehicleId(tr.VEHICLE_ID);
    const lng = Number(tr.LAST_LNG);
    const lat = Number(tr.LAST_LAT);
    if (Number.isFinite(lng) && Number.isFinite(lat)) {
      setViewState(prev => ({ ...prev, longitude: lng, latitude: lat, zoom: 14 }));
      mapContainerRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  }, []);

  const generateRationale = useCallback(async (tr: Trailer) => {
    setRationaleLoading(true);
    setRationale({ vehicleId: tr.VEHICLE_ID, text: '...' });
    const near = nearestTerminals(tr.LAST_LNG, tr.LAST_LAT, 3);
    const prompt = [
      `You are a fleet dispatcher writing a short, imperative Action Alert for an idle trailer.`,
      `Trailer ${tr.VEHICLE_ID} has been idle ${tr.IDLE_DAYS.toFixed(2)} days (${tr.IDLE_HOURS.toFixed(1)}h) at ${tr.LAST_LOCATION_NAME} (${tr.LAST_LOCATION_TYPE}).`,
      `Cost of idleness so far: $${Number(tr.COST_OF_IDLENESS_USD).toFixed(0)}.`,
      `Top demand terminals (high net-outbound trips, trailer-short):`,
      ...near.map((t, i) => `${i + 1}. ${t.TERMINAL_NAME} - DEMAND_SCORE ${t.DEMAND_SCORE} (${t.NET_OUTBOUND_TRIPS} net outbound)`),
      `Recommend exactly one terminal to reposition to. Reply with ONE sentence containing: trailer ID, target terminal, an estimate of weekly rental savings, and a one-line rationale. No preamble.`,
    ].join('\n');
    const escaped = prompt.replace(/'/g, "''");
    const rows = await sfQuery(`SELECT SNOWFLAKE.CORTEX.COMPLETE('claude-sonnet-4-5', '${escaped}') AS R`);
    const text = (rows[0]?.R || '').toString().trim();
    setRationale({ vehicleId: tr.VEHICLE_ID, text: text || '(no response)' });
    setRationaleLoading(false);
  }, [nearestTerminals]);

  const optimizeRepositioning = useCallback(async () => {
    if (!trailers.length || !terminals.length) return;
    setSolving(true);
    setRoutePaths([]);
    setVrpResult(null);

    const topTrailers = sortedTrailers.slice(0, Math.min(8, sortedTrailers.length));
    const topTerminals = terminals.slice(0, Math.min(topTrailers.length, terminals.length));

    const vrpJobs = topTerminals.map((t, i) => ({
      id: i + 1,
      location: [Number(t.TERMINAL_LNG), Number(t.TERMINAL_LAT)],
      service: 600,
      priority: Math.min(100, Math.round(Number(t.DEMAND_SCORE) || 1)),
    }));
    const vrpVehicles = topTrailers.map((tr, i) => ({
      id: i + 1,
      profile: orsProfile,
      start: [Number(tr.LAST_LNG), Number(tr.LAST_LAT)],
      capacity: [1],
    }));
    const challenge = { jobs: vrpJobs, vehicles: vrpVehicles };
    const rows = await sfQuery(
      `SELECT * FROM TABLE(OPENROUTESERVICE_APP.CORE.OPTIMIZATION(PARSE_JSON('${JSON.stringify(challenge).replace(/'/g, "''")}')))`,
      'OPENROUTESERVICE_APP', 'CORE',
    );
    if (rows.length) {
      setVrpResult(rows[0]);
      const paths: any[] = [];
      for (const row of rows) {
        if (row.GEOJSON) {
          try {
            const geojson = typeof row.GEOJSON === 'string' ? JSON.parse(row.GEOJSON) : row.GEOJSON;
            paths.push({ vehicleIdx: (row.VEHICLE || 1) - 1, geojson });
          } catch (e) {
            console.error('[VRP] GEOJSON parse error:', e);
          }
        }
      }
      setRoutePaths(paths);
      if (paths.length === 0) {
        setVrpResult({ warning: `Solver returned no routable paths. Profile '${orsProfile}' may not be available for region '${regionName}'.` });
      }
    } else {
      setVrpResult({ warning: `Solver returned no rows. Profile '${orsProfile}' may not be available for region '${regionName}'.` });
    }
    setSolving(false);
  }, [trailers, terminals, sortedTrailers, orsProfile, regionName]);

  const basemap = useMemo(() => cartoBasemap(), []);

  const dataLayers = useMemo(() => {
    const result: any[] = [];
    if (terminals.length) {
      result.push(new ScatterplotLayer({
        id: 'demand-terminals',
        data: terminals,
        getPosition: (d: any) => [Number(d.TERMINAL_LNG), Number(d.TERMINAL_LAT)],
        getFillColor: [41, 121, 232, 160],
        getLineColor: [255, 255, 255, 220],
        stroked: true,
        getRadius: (d: any) => 80 + Number(d.DEMAND_SCORE) * 12,
        radiusMinPixels: 6,
        radiusMaxPixels: 30,
        pickable: true,
      }));
    }
    if (trailers.length) {
      result.push(new ScatterplotLayer({
        id: 'idle-trailers',
        data: trailers,
        getPosition: (d: any) => [Number(d.LAST_LNG), Number(d.LAT) || Number(d.LAST_LAT)],
        getFillColor: (d: any) => [...(SEVERITY_COLOR[d.IDLE_SEVERITY] || [220, 38, 38]), 200] as any,
        getLineColor: (d: any) => d.VEHICLE_ID === selectedVehicleId ? [41, 181, 232, 255] : [255, 255, 255, 240],
        stroked: true,
        lineWidthMinPixels: 1,
        getLineWidth: (d: any) => d.VEHICLE_ID === selectedVehicleId ? 4 : 1,
        getRadius: (d: any) => 60 + Math.min(Number(d.IDLE_HOURS) * 8, 240),
        radiusMinPixels: 5,
        radiusMaxPixels: 26,
        pickable: true,
      }));
    }
    routePaths.forEach((rp, i) => {
      result.push(new GeoJsonLayer({
        id: `reposition-${i}`,
        data: rp.geojson,
        stroked: true,
        filled: false,
        getLineColor: [34, 197, 94, 220],
        lineWidthMinPixels: 3,
      }));
    });
    return result;
  }, [terminals, trailers, routePaths, selectedVehicleId]);

  const layers = useMemo(() => [basemap, ...dataLayers].filter(Boolean), [basemap, dataLayers]);

  const getTooltip = useCallback(({ object }: any) => {
    if (!object) return null;
    if (object.VEHICLE_ID) {
      return {
        html: `<b>${object.VEHICLE_ID}</b><br/>Idle: ${Number(object.IDLE_HOURS).toFixed(1)}h (${Number(object.IDLE_DAYS).toFixed(2)}d)<br/>${object.LAST_LOCATION_NAME}<br/>Cost: $${Number(object.COST_OF_IDLENESS_USD).toFixed(0)} (${object.IDLE_SEVERITY})`,
        style: { backgroundColor: '#14141f', color: '#e8e8f0', padding: '8px', borderRadius: '4px', fontSize: '12px' },
      };
    }
    if (object.TERMINAL_ID) {
      return {
        html: `<b>${object.TERMINAL_NAME}</b><br/>Demand score: ${object.DEMAND_SCORE}<br/>Net outbound: ${object.NET_OUTBOUND_TRIPS} trips`,
        style: { backgroundColor: '#14141f', color: '#e8e8f0', padding: '8px', borderRadius: '4px', fontSize: '12px' },
      };
    }
    return null;
  }, []);

  if (pipelineMissing) {
    return (
      <div className="panel">
        <h2 style={{ fontSize: 20, marginBottom: 4 }}>Asset Velocity</h2>
        <p className="subtitle">Non-Moving Trailer Detection &amp; Action Engine</p>
        <div className="info-box" style={{ background: 'rgba(245,158,11,0.1)', border: '1px solid #F59E0B', padding: 16, borderRadius: 8, marginTop: 16 }}>
          <strong>Pipeline not deployed</strong>
          <p style={{ marginTop: 8 }}>
            This page reads from <code>FLEET_INTELLIGENCE.DWELL_ANALYSIS.DT_DWELL_ENRICHED</code>, which has not been created yet.
          </p>
          <p>Deploy the <code>dwell-analysis</code> skill first, then return here. Asset Velocity reuses dwell sessions to detect ghost trailers, so the dwell pipeline is its single prerequisite.</p>
        </div>
      </div>
    );
  }

  return (
    <div className="panel">
      <h2 style={{ fontSize: 20, marginBottom: 4 }}>Asset Velocity</h2>
      <p className="subtitle">Non-Moving Trailer Detection &amp; Action Engine - reusing the dwell pipeline to surface ghost trailers, score cost of idleness, and recommend repositioning moves toward high-demand lanes.</p>

      <div style={{ display: 'flex', gap: 12, marginBottom: 12, flexWrap: 'wrap', alignItems: 'flex-end' }}>
        <div style={{ minWidth: 240 }}>
          <label className="range-label">Idle threshold: {idleHourThreshold}h ({(idleHourThreshold / 24).toFixed(2)}d)</label>
          <input type="range" min={0.25} max={336} step={0.25} value={idleHourThreshold} onChange={e => setIdleHourThreshold(Number(e.target.value))} style={{ width: '100%' }} />
          <div style={{ fontSize: 11, color: 'var(--text-secondary)' }}>Default 72h (3d) surfaces ghost trailers. Severity bands: WATCH 3d, WARNING 7d, CRITICAL 14d.</div>
        </div>
        <button className="btn-primary" onClick={loadData} disabled={loading} style={{ fontSize: 12 }}>{loading ? 'Loading...' : 'Refresh'}</button>
        <button className="btn-primary" onClick={optimizeRepositioning} disabled={solving || !trailers.length || !terminals.length} style={{ fontSize: 12, background: '#0DB048' }}>
          {solving ? 'Solving...' : 'Optimize Repositioning'}
        </button>
        <span style={{ fontSize: 11, color: 'var(--text-secondary)', alignSelf: 'center' }}>profile: {orsProfile}</span>
      </div>

      <div className="metric-grid">
        <MetricCard label="Ghost Trailers" value={totals.ghost} subtitle={`>= ${idleHourThreshold}h idle`} />
        <MetricCard label="Cost of Idleness" value={`$${totals.cost.toLocaleString(undefined, { maximumFractionDigits: 0 })}`} subtitle="cumulative across fleet" />
        <MetricCard label="Avg Idle Days" value={totals.avgDays.toFixed(2)} subtitle="mean duration" />
        <MetricCard label="Projected Savings" value={`$${totals.projected.toLocaleString(undefined, { maximumFractionDigits: 0 })}`} subtitle="capture rate applied" />
      </div>

      {vrpResult && (
        <div className={`info-box ${vrpResult.warning ? 'warning' : 'success'}`} style={{ marginTop: 8, background: vrpResult.warning ? 'rgba(245,158,11,0.1)' : undefined, border: vrpResult.warning ? '1px solid #F59E0B' : undefined, padding: vrpResult.warning ? 12 : undefined, borderRadius: vrpResult.warning ? 8 : undefined }}>
          {vrpResult.warning
            ? vrpResult.warning
            : `Repositioning solution: ${routePaths.length} reposition routes generated for top ${Math.min(8, trailers.length)} idle trailers.`}
        </div>
      )}

      <div ref={mapContainerRef} style={{ height: 420, borderRadius: 8, border: '1px solid var(--border)', overflow: 'hidden', position: 'relative', background: '#e8e8e8', marginTop: 12 }}>
        {(loading || solving) && <div style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, background: 'rgba(0,0,0,0.5)', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#fff', zIndex: 10, fontSize: 14 }}>{solving ? 'Solving repositioning VRP...' : 'Loading...'}</div>}
        {mapDims && <DeckGL width={mapDims.width} height={mapDims.height} viewState={viewState} onViewStateChange={({ viewState: vs }: any) => setViewState(vs)} controller={true} layers={layers} getTooltip={getTooltip} style={{ position: 'absolute', top: '0', left: '0', width: `${mapDims.width}px`, height: `${mapDims.height}px` }} />}
      </div>

      <div style={{ display: 'flex', gap: 16, marginTop: 4, fontSize: 11, color: 'var(--text-secondary)' }}>
        <span><span style={{ display: 'inline-block', width: 10, height: 10, borderRadius: '50%', background: 'rgb(220,38,38)', marginRight: 4 }} /> Idle trailers (size = idle hours)</span>
        <span><span style={{ display: 'inline-block', width: 10, height: 10, borderRadius: '50%', background: 'rgb(41,121,232)', marginRight: 4 }} /> Demand terminals (size = demand score)</span>
        <span><span style={{ display: 'inline-block', width: 14, height: 3, background: 'rgb(34,197,94)', verticalAlign: 'middle', marginRight: 4 }} /> Reposition route</span>
      </div>

      <div style={{ marginTop: 16 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
          <h3 style={{ fontSize: 14, margin: 0 }}>Action Alerts ({trailers.length})</h3>
          <div style={{ fontSize: 12 }}>
            Sort by:&nbsp;
            <select className="select" value={sortBy} onChange={e => setSortBy(e.target.value as keyof Trailer)} style={{ fontSize: 12 }}>
              <option value="COST_OF_IDLENESS_USD">Cost of Idleness</option>
              <option value="IDLE_HOURS">Idle Hours</option>
              <option value="ASSIGNED_DISPATCHER">Dispatcher</option>
              <option value="LAST_LOCATION_NAME">Location</option>
            </select>
          </div>
        </div>
        <div style={{ maxHeight: 320, overflow: 'auto', border: '1px solid var(--border)', borderRadius: 8 }}>
          <table style={{ width: '100%', fontSize: 12, borderCollapse: 'collapse' }}>
            <thead style={{ position: 'sticky', top: 0, background: 'var(--surface)', zIndex: 1 }}>
              <tr style={{ textAlign: 'left' }}>
                <th style={{ padding: '8px' }}>Trailer</th>
                <th style={{ padding: '8px' }}>Last Location</th>
                <th style={{ padding: '8px' }}>Idle</th>
                <th style={{ padding: '8px' }}>Severity</th>
                <th style={{ padding: '8px' }}>Dispatcher</th>
                <th style={{ padding: '8px', textAlign: 'right' }}>Cost ($)</th>
                <th style={{ padding: '8px' }}></th>
              </tr>
            </thead>
            <tbody>
              {sortedTrailers.map(tr => {
                const sev = SEVERITY_COLOR[tr.IDLE_SEVERITY] || [128, 128, 128];
                return (
                  <tr key={tr.VEHICLE_ID} onClick={() => focusTrailer(tr)} style={{ borderTop: '1px solid var(--border)', cursor: 'pointer', background: tr.VEHICLE_ID === selectedVehicleId ? 'rgba(41,181,232,0.10)' : 'transparent' }}>
                    <td style={{ padding: '6px 8px', fontFamily: 'monospace' }}>{tr.VEHICLE_ID}</td>
                    <td style={{ padding: '6px 8px' }}>{tr.LAST_LOCATION_NAME} <span style={{ color: 'var(--text-secondary)', fontSize: 10 }}>({tr.LAST_LOCATION_TYPE})</span></td>
                    <td style={{ padding: '6px 8px' }}>{Number(tr.IDLE_HOURS).toFixed(1)}h / {Number(tr.IDLE_DAYS).toFixed(2)}d</td>
                    <td style={{ padding: '6px 8px' }}>
                      <span style={{ background: `rgba(${sev.join(',')},0.15)`, color: `rgb(${sev.join(',')})`, padding: '2px 8px', borderRadius: 10, fontWeight: 600 }}>{tr.IDLE_SEVERITY}</span>
                    </td>
                    <td style={{ padding: '6px 8px', fontFamily: 'monospace' }}>{tr.ASSIGNED_DISPATCHER}</td>
                    <td style={{ padding: '6px 8px', textAlign: 'right' }}>${Number(tr.COST_OF_IDLENESS_USD).toFixed(0)}</td>
                    <td style={{ padding: '6px 8px' }}>
                      <button onClick={(e) => { e.stopPropagation(); generateRationale(tr); }} disabled={rationaleLoading} style={{ fontSize: 11, padding: '3px 8px', borderRadius: 4, border: '1px solid var(--border)', background: 'transparent', cursor: 'pointer' }}>AI Rationale</button>
                    </td>
                  </tr>
                );
              })}
              {!trailers.length && !loading && (
                <tr><td colSpan={7} style={{ padding: 16, textAlign: 'center', color: 'var(--text-secondary)' }}>No idle trailers above threshold. Lower the threshold or generate trucking telemetry via Data Studio.</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      {rationale && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 100 }} onClick={() => setRationale(null)}>
          <div style={{ background: 'var(--surface)', borderRadius: 8, padding: 20, maxWidth: 560, width: '90%', boxShadow: '0 12px 36px rgba(0,0,0,0.4)' }} onClick={e => e.stopPropagation()}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
              <h3 style={{ fontSize: 15, margin: 0 }}>Action Alert - {rationale.vehicleId}</h3>
              <button onClick={() => setRationale(null)} style={{ fontSize: 18, background: 'transparent', border: 'none', cursor: 'pointer', color: 'var(--text-secondary)' }}>x</button>
            </div>
            <div style={{ fontSize: 13, lineHeight: 1.6, padding: 12, background: 'rgba(41,181,232,0.08)', borderRadius: 6, border: '1px solid rgba(41,181,232,0.3)' }}>
              {rationaleLoading ? 'Generating with Snowflake Cortex (claude-sonnet-4-5)...' : rationale.text}
            </div>
            <div style={{ fontSize: 10, color: 'var(--text-secondary)', marginTop: 8 }}>Generated by SNOWFLAKE.CORTEX.COMPLETE using top-3 nearest demand terminals as context.</div>
          </div>
        </div>
      )}
    </div>
  );
}

import { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import MetricCard from '../shared/MetricCard';
import DeckGL from '@deck.gl/react';
import { ScatterplotLayer, GeoJsonLayer } from '@deck.gl/layers';
import { useRegion } from '../hooks/useRegion';
import { useFitMap } from '../shared/useFitMap';
import RecenterButton from '../shared/RecenterButton';
import { coordsFromGeoJSON, type LngLat } from '../shared/mapFit';
import PageContainer from '../shared/PageContainer';
import {
  RO_DB, RO_SCHEMA,
  sfQuery, cartoBasemap, SEVERITY_COLOR, asSqlJsonLiteral,
  Trailer, Terminal, MatrixCache, ExclusionReason,
} from './asset-velocity/helpers';
import {
  profileForFleet, fleetEnvelope, avoidFeaturesArr,
  fetchMatrix, nearestByRoad, fetchTrailerIsochrone,
} from './asset-velocity/ors-helpers';
import { buildChallenge, skillsForTrailer, skillsForTerminal } from './asset-velocity/vroom-mapper';

const MATRIX_TRAILER_CAP = 50;   // matrix call capped at 50 trailers + 50 terminals
const MATRIX_TERMINAL_CAP = 50;
const VRP_TOP_N = 8;

export default function AssetVelocity() {
  const { regionName, center, zoom } = useRegion();
  const [idleHourThreshold, setIdleHourThreshold] = useState(4);
  const [trailers, setTrailers] = useState<Trailer[]>([]);
  const [terminals, setTerminals] = useState<Terminal[]>([]);
  const [loading, setLoading] = useState(false);
  const [matrixLoading, setMatrixLoading] = useState(false);
  const [pipelineMissing, setPipelineMissing] = useState(false);
  const [rationale, setRationale] = useState<{ vehicleId: string; text: string } | null>(null);
  const [rationaleLoading, setRationaleLoading] = useState(false);
  const [solving, setSolving] = useState(false);
  const [routePaths, setRoutePaths] = useState<any[]>([]);
  const [vrpResult, setVrpResult] = useState<any>(null);
  const [sortBy, setSortBy] = useState<keyof Trailer>('COST_OF_IDLENESS_USD');
  const [selectedVehicleId, setSelectedVehicleId] = useState<string | null>(null);
  const [orsProfile, setOrsProfile] = useState<string>('driving-car');
  const [matrix, setMatrix] = useState<MatrixCache>({});
  const [matrixError, setMatrixError] = useState<string | null>(null);
  const [maxRepositionMinutes, setMaxRepositionMinutes] = useState<number>(600);
  const [avoidFeatures, setAvoidFeatures] = useState<string>('tollways,ferries');
  const [isoByVehicle, setIsoByVehicle] = useState<Record<string, any>>({});
  const lastIsoRef = useRef<string | null>(null);

  useEffect(() => {
    setRoutePaths([]);
    setVrpResult(null);
    setRationale(null);
    setSelectedVehicleId(null);
    setMatrix({});
    setIsoByVehicle({});
    lastIsoRef.current = null;
  }, [center.lng, center.lat, zoom, regionName]);

  // ----- Data load -----
  const loadData = useCallback(async () => {
    setLoading(true);
    setPipelineMissing(false);
    const probe = await sfQuery(`SELECT 1 AS OK FROM FLEET_INTELLIGENCE.DWELL_ANALYSIS.DT_DWELL_ENRICHED LIMIT 1`, 'FLEET_INTELLIGENCE', 'DWELL_ANALYSIS');
    if (!probe.length) {
      setPipelineMissing(true);
      setLoading(false);
      return;
    }
    // CONFIG.REGION + CONFIG.VEHICLE_TYPE are kept in sync atomically by the
    // dataset picker (`POST /api/datasets/activate`). The page used to do its
    // own UPDATE here, but `/api/query` is read-only (SELECT/SHOW/DESCRIBE/CALL/WITH)
    // so that UPDATE silently 403'd. Removed in v1.1.
    const trailerSql = `
      SELECT VEHICLE_ID, REGION, LAST_LOCATION_NAME, LAST_LOCATION_TYPE,
             LAST_LNG, LAST_LAT, IDLE_SINCE::STRING AS IDLE_SINCE,
             IDLE_HOURS, IDLE_DAYS, ASSIGNED_DISPATCHER,
             COST_OF_IDLENESS_USD, PROJECTED_SAVINGS_USD, IDLE_SEVERITY,
             VEHICLE_SUBTYPE, HAZMAT, WEIGHT_TONS, HEIGHT_M, LENGTH_M, WIDTH_M, AXLELOAD_T,
             ORS_PROFILE, MAX_REPOSITION_MINUTES, AVOID_FEATURES
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
    const trailerRows = t as Trailer[];
    setTrailers(trailerRows);
    setTerminals(tm as Terminal[]);
    const fleetProfile = profileForFleet(trailerRows);
    setOrsProfile((pr[0]?.ORS_PROFILE as string) || fleetProfile || 'driving-car');
    if (trailerRows.length) {
      setMaxRepositionMinutes(Number(trailerRows[0].MAX_REPOSITION_MINUTES) || 600);
      setAvoidFeatures(String(trailerRows[0].AVOID_FEATURES || 'tollways,ferries'));
    }
    setLoading(false);
  }, [regionName, idleHourThreshold]);

  useEffect(() => { loadData(); }, [loadData]);

  // ----- Matrix fetch (U1 + U4) -----
  const refreshMatrix = useCallback(async (forTrailers: Trailer[], forTerminals: Terminal[]) => {
    if (!forTrailers.length || !forTerminals.length) {
      setMatrix({});
      return;
    }
    setMatrixLoading(true);
    try {
      const cappedTrailers = forTrailers.slice(0, MATRIX_TRAILER_CAP);
      const cappedTerminals = forTerminals.slice(0, MATRIX_TERMINAL_CAP);
      const profile = profileForFleet(cappedTrailers);
      const envelope = fleetEnvelope(cappedTrailers);
      const avoid = avoidFeaturesArr(avoidFeatures);
      const cache = await fetchMatrix(cappedTrailers, cappedTerminals, profile, envelope, avoid, regionName, maxRepositionMinutes);
      setMatrix(cache);
      setMatrixError(null);
    } catch (e: any) {
      console.error('[AV] matrix fetch failed', e);
      setMatrix({});
      setMatrixError((e?.message ?? 'matrix fetch failed').toString().slice(0, 240));
    } finally {
      setMatrixLoading(false);
    }
  }, [regionName, avoidFeatures, maxRepositionMinutes]);

  useEffect(() => {
    if (trailers.length && terminals.length) refreshMatrix(trailers, terminals);
  }, [trailers, terminals, refreshMatrix]);

  // ----- KPI totals -----
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

  // ----- Reachability gate (U2) -----
  function exclusionReasonFor(trailer: Trailer, terminal: Terminal): ExclusionReason | null {
    const cell = matrix[trailer.VEHICLE_ID]?.[terminal.TERMINAL_ID];
    if (cell) {
      if (cell.durationSec == null) return 'NOT_ROUTABLE';
      if (!cell.reachable) return 'OUT_OF_SHIFT';
    }
    // Skill check: terminal demands skill X but trailer doesn't have it
    const need = skillsForTerminal(terminal);
    const have = skillsForTrailer(trailer);
    if (need.length && !need.every(s => have.includes(s))) return 'INCOMPATIBLE_SKILL';
    return null;
  }

  // For a single trailer, partition the fleet's terminal list into reachable / excluded.
  function reachabilityForTrailer(trailer: Trailer): {
    reachable: Array<Terminal & { durationSec: number; distanceM: number | null }>;
    excluded: Array<Terminal & { reason: ExclusionReason }>;
  } {
    const reachable = nearestByRoad(trailer, terminals, matrix, terminals.length)
      .filter(t => exclusionReasonFor(trailer, t) === null);
    const reachableIds = new Set(reachable.map(t => t.TERMINAL_ID));
    const excluded = terminals
      .filter(t => !reachableIds.has(t.TERMINAL_ID))
      .map(t => ({ ...t, reason: (exclusionReasonFor(trailer, t) ?? 'NOT_ROUTABLE') as ExclusionReason }));
    return { reachable, excluded };
  }

  // ----- Selected trailer + isochrone (U2 visualisation) -----
  const focusTrailer = useCallback((tr: Trailer) => {
    setSelectedVehicleId(tr.VEHICLE_ID);
    mapContainerRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    if (tr.VEHICLE_ID !== lastIsoRef.current && !isoByVehicle[tr.VEHICLE_ID]) {
      lastIsoRef.current = tr.VEHICLE_ID;
      const profile = profileForFleet([tr]);
      fetchTrailerIsochrone(tr, profile, regionName, maxRepositionMinutes * 60).then(geo => {
        if (geo) setIsoByVehicle(prev => ({ ...prev, [tr.VEHICLE_ID]: geo }));
      }).catch(e => console.warn('[AV] iso fetch failed', e));
    }
  }, [isoByVehicle, regionName, maxRepositionMinutes]);

  const selectedTrailer = useMemo(() => trailers.find(t => t.VEHICLE_ID === selectedVehicleId) || null, [trailers, selectedVehicleId]);
  const selectedReachability = useMemo(() => selectedTrailer ? reachabilityForTrailer(selectedTrailer) : null, [selectedTrailer, matrix, terminals]);  // eslint-disable-line react-hooks/exhaustive-deps

  // ----- AI Rationale (Bonus: now uses matrix-based road duration + skills) -----
  const generateRationale = useCallback(async (tr: Trailer) => {
    setRationaleLoading(true);
    setRationale({ vehicleId: tr.VEHICLE_ID, text: '...' });
    const near = nearestByRoad(tr, terminals, matrix, 3)
      .filter(t => exclusionReasonFor(tr, t) === null);
    const subtype = tr.VEHICLE_SUBTYPE || 'DRY';
    const lines: string[] = [
      `You are a fleet dispatcher writing a short, imperative Action Alert for an idle trailer.`,
      `Trailer ${tr.VEHICLE_ID} (${subtype}, ${tr.WEIGHT_TONS ?? '?'} t) has been idle ${tr.IDLE_DAYS.toFixed(2)} days (${tr.IDLE_HOURS.toFixed(1)}h) at ${tr.LAST_LOCATION_NAME} (${tr.LAST_LOCATION_TYPE}).`,
      `Cost of idleness so far: $${Number(tr.COST_OF_IDLENESS_USD).toFixed(0)}.`,
      `Reachable demand terminals within remaining ${maxRepositionMinutes} min shift (road duration via ORS HGV graph):`,
    ];
    if (near.length === 0) {
      lines.push('NONE within reachable shift.');
    } else {
      near.forEach((t, i) => {
        const minutes = Math.round((t.durationSec || 0) / 60);
        const km = t.distanceM != null ? (t.distanceM / 1000).toFixed(1) : '?';
        const need = skillsForTerminal(t);
        const skillLabel = need.includes(1) ? ' (REEFER lane)' : '';
        lines.push(`${i + 1}. ${t.TERMINAL_NAME} - ${minutes} min / ${km} km, demand_score ${t.DEMAND_SCORE}, ${t.NET_OUTBOUND_TRIPS} net outbound${skillLabel}`);
      });
    }
    lines.push(`Recommend exactly one terminal to reposition to. Reply with ONE sentence containing: trailer ID, target terminal, an estimate of weekly rental savings, and a one-line rationale. No preamble.`);
    const prompt = lines.join('\n');
    const escaped = prompt.replace(/'/g, "''");
    const rows = await sfQuery(`SELECT SNOWFLAKE.CORTEX.COMPLETE('claude-sonnet-4-5', '${escaped}') AS R`);
    const text = (rows[0]?.R || '').toString().trim();
    setRationale({ vehicleId: tr.VEHICLE_ID, text: text || '(no response)' });
    setRationaleLoading(false);
  }, [terminals, matrix, maxRepositionMinutes]);

  // ----- VROOM Optimize Repositioning (U3 + U4) -----
  const optimizeRepositioning = useCallback(async () => {
    if (!trailers.length || !terminals.length) return;
    setSolving(true);
    setRoutePaths([]);
    setVrpResult(null);

    const topTrailers = sortedTrailers.slice(0, Math.min(VRP_TOP_N, sortedTrailers.length));
    const topTerminals = terminals.slice(0, Math.min(topTrailers.length, terminals.length));
    const profile = profileForFleet(topTrailers);
    const challenge = buildChallenge({
      trailers: topTrailers,
      terminals: topTerminals,
      profile,
      maxRepositionMinutes,
      nowEpoch: Math.floor(Date.now() / 1000),
    });

    let rows: any[] = [];
    try {
      rows = await sfQuery(
        `SELECT * FROM TABLE(OPENROUTESERVICE_APP.CORE.OPTIMIZATION(PARSE_JSON(${asSqlJsonLiteral(challenge)}), '${regionName}'))`,
        'OPENROUTESERVICE_APP', 'CORE', { throwOnError: true },
      );
    } catch (e: any) {
      const msg = (e?.message ?? 'unknown error').toString().slice(0, 240);
      setVrpResult({ warning: `Optimize Repositioning failed: ${msg}` });
      setSolving(false);
      return;
    }

    if (rows.length) {
      const paths: any[] = [];
      let totalDur = 0;
      for (const row of rows) {
        if (row.GEOJSON) {
          try {
            const geojson = typeof row.GEOJSON === 'string' ? JSON.parse(row.GEOJSON) : row.GEOJSON;
            paths.push({ vehicleIdx: (row.VEHICLE || 1) - 1, geojson });
            totalDur += Number(row.DURATION || 0);
          } catch (e) {
            console.error('[VRP] GEOJSON parse error:', e);
          }
        }
      }
      setRoutePaths(paths);
      // Try to extract unassigned count from RESPONSE.summary.unassigned
      let unassigned = 0;
      try {
        const r0 = rows[0]?.RESPONSE;
        const respObj = typeof r0 === 'string' ? JSON.parse(r0) : r0;
        unassigned = Number(respObj?.summary?.unassigned ?? 0);
      } catch { /* ignore */ }
      setVrpResult({
        routesCount: paths.length,
        unassignedCount: unassigned,
        totalDurationSec: totalDur,
        message: paths.length === 0
          ? `Solver returned no routable paths. Profile '${profile}' may not be available for region '${regionName}'.`
          : null,
      });
    } else {
      setVrpResult({ warning: `Solver returned no rows. Profile '${profile}' may not be available for region '${regionName}'.` });
    }
    setSolving(false);
  }, [trailers, terminals, sortedTrailers, regionName, maxRepositionMinutes]);

  const basemap = useMemo(() => cartoBasemap(), []);

  const dataLayers = useMemo(() => {
    const result: any[] = [];
    // Selected trailer's reachability polygon (subtle blue fill).
    if (selectedTrailer && isoByVehicle[selectedTrailer.VEHICLE_ID]) {
      result.push(new GeoJsonLayer({
        id: 'reachability-iso',
        data: isoByVehicle[selectedTrailer.VEHICLE_ID],
        stroked: true,
        filled: true,
        getFillColor: [41, 121, 232, 35],
        getLineColor: [41, 121, 232, 180],
        lineWidthMinPixels: 1.5,
      }));
    }
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
        getPosition: (d: any) => [Number(d.LAST_LNG), Number(d.LAST_LAT)],
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
  }, [terminals, trailers, routePaths, selectedVehicleId, selectedTrailer, isoByVehicle]);

  const layers = useMemo(() => [basemap, ...dataLayers].filter(Boolean), [basemap, dataLayers]);

  const fitCoords = useMemo<LngLat[]>(() => {
    const out: LngLat[] = [];
    for (const t of terminals) {
      if (t.TERMINAL_LNG != null && t.TERMINAL_LAT != null) out.push([Number(t.TERMINAL_LNG), Number(t.TERMINAL_LAT)]);
    }
    for (const tr of trailers) {
      if (tr.LAST_LNG != null && tr.LAST_LAT != null) out.push([Number(tr.LAST_LNG), Number(tr.LAST_LAT)]);
    }
    for (const rp of routePaths) {
      if (rp.geojson) out.push(...coordsFromGeoJSON(rp.geojson));
    }
    return out;
  }, [terminals, trailers, routePaths]);
  const fallback = useMemo(() => ({ longitude: center.lng || -122.4194, latitude: center.lat || 37.7749, zoom: zoom || 11, pitch: 0, bearing: 0 }), [center.lng, center.lat, zoom]);
  const { containerRef: mapContainerRef, dims: mapDims, viewState, onViewStateChange, recenter } = useFitMap(fitCoords, { fallback, regionKey: regionName });

  const getTooltip = useCallback(({ object }: any) => {
    if (!object) return null;
    if (object.VEHICLE_ID) {
      return {
        html: `<b>${object.VEHICLE_ID}</b> ${object.VEHICLE_SUBTYPE ? `[${object.VEHICLE_SUBTYPE}]` : ''}<br/>Idle: ${Number(object.IDLE_HOURS).toFixed(1)}h (${Number(object.IDLE_DAYS).toFixed(2)}d)<br/>${object.LAST_LOCATION_NAME}<br/>Cost: $${Number(object.COST_OF_IDLENESS_USD).toFixed(0)} (${object.IDLE_SEVERITY})`,
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
    <PageContainer width="wide" padded={false}>
    <div className="panel">
      <h2 style={{ fontSize: 20, marginBottom: 4 }}>Asset Velocity</h2>
      <p className="subtitle">Non-Moving Trailer Detection &amp; Action Engine - now powered by ORS road-network matrix, isochrone reachability gate, and full VROOM constraints (skills, time windows, breaks, costs).</p>

      <div style={{ display: 'flex', gap: 12, marginBottom: 12, flexWrap: 'wrap', alignItems: 'flex-end' }}>
        <div style={{ minWidth: 240 }}>
          <label className="range-label">Idle threshold: {idleHourThreshold < 1
            ? `${Math.round(idleHourThreshold * 60)} min`
            : `${idleHourThreshold.toFixed(2)}h (${(idleHourThreshold / 24).toFixed(2)}d)`}</label>
          <input type="range" min={0.0833} max={336} step={0.0833} value={idleHourThreshold} onChange={e => setIdleHourThreshold(Number(e.target.value))} style={{ width: '100%' }} />
          <div style={{ fontSize: 11, color: 'var(--text-secondary)' }}>Default 72h (3d) surfaces ghost trailers. Severity bands: WATCH 3d, WARNING 7d, CRITICAL 14d.</div>
        </div>
        <div style={{ minWidth: 200 }}>
          <label className="range-label">Reposition shift cap: {maxRepositionMinutes} min ({(maxRepositionMinutes / 60).toFixed(1)}h)</label>
          <input type="range" min={60} max={840} step={30} value={maxRepositionMinutes} onChange={e => setMaxRepositionMinutes(Number(e.target.value))} style={{ width: '100%' }} />
          <div style={{ fontSize: 11, color: 'var(--text-secondary)' }}>Drives matrix gate + VROOM time_window + isochrone polygon.</div>
        </div>
        <button className="btn-primary" onClick={loadData} disabled={loading} style={{ fontSize: 12 }}>{loading ? 'Loading...' : 'Refresh'}</button>
        <button className="btn-primary" onClick={optimizeRepositioning} disabled={solving || !trailers.length || !terminals.length || matrixLoading} style={{ fontSize: 12, background: '#0DB048' }}>
          {solving ? 'Solving...' : 'Optimize Repositioning'}
        </button>
        <span style={{ fontSize: 11, color: 'var(--text-secondary)', alignSelf: 'center' }}>profile: {orsProfile} &middot; avoid: {avoidFeatures || '(none)'}</span>
      </div>

      <div className="metric-grid">
        <MetricCard label="Ghost Trailers" value={totals.ghost} subtitle={`>= ${idleHourThreshold < 1 ? `${Math.round(idleHourThreshold * 60)} min` : `${idleHourThreshold}h`} idle`} />
        <MetricCard label="Cost of Idleness" value={`$${totals.cost.toLocaleString(undefined, { maximumFractionDigits: 0 })}`} subtitle="cumulative across fleet" />
        <MetricCard label="Avg Idle Days" value={totals.avgDays.toFixed(2)} subtitle="mean duration" />
        <MetricCard label="Projected Savings" value={`$${totals.projected.toLocaleString(undefined, { maximumFractionDigits: 0 })}`} subtitle="capture rate applied" />
      </div>

      {vrpResult && (
        <div className={`info-box ${vrpResult.warning ? 'warning' : 'success'}`} style={{ marginTop: 8, background: vrpResult.warning ? 'rgba(245,158,11,0.1)' : undefined, border: vrpResult.warning ? '1px solid #F59E0B' : undefined, padding: vrpResult.warning ? 12 : undefined, borderRadius: vrpResult.warning ? 8 : undefined }}>
          {vrpResult.warning
            ? vrpResult.warning
            : vrpResult.message
              ? vrpResult.message
              : `Repositioning solution: ${vrpResult.routesCount} reposition routes (${vrpResult.unassignedCount ?? 0} unassigned), total drive time ${Math.round((vrpResult.totalDurationSec || 0) / 60)} min.`}
        </div>
      )}

      {matrixError && (
        <div className="info-box warning" style={{ marginTop: 8, background: 'rgba(245,158,11,0.1)', border: '1px solid #F59E0B', padding: 12, borderRadius: 8 }}>
          ORS matrix call failed: {matrixError}
        </div>
      )}

      <div ref={mapContainerRef} style={{ height: 420, borderRadius: 8, border: '1px solid var(--border)', overflow: 'hidden', position: 'relative', background: '#e8e8e8', marginTop: 12 }}>
        {(loading || solving || matrixLoading) && <div style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, background: 'rgba(0,0,0,0.5)', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#fff', zIndex: 10, fontSize: 14 }}>{solving ? 'Solving repositioning VRP...' : matrixLoading ? 'Computing ORS road-network matrix...' : 'Loading...'}</div>}
        {mapDims && <DeckGL width={mapDims.width} height={mapDims.height} viewState={viewState} onViewStateChange={onViewStateChange} controller={true} layers={layers} getTooltip={getTooltip} style={{ position: 'absolute', top: '0', left: '0', width: `${mapDims.width}px`, height: `${mapDims.height}px` }} />}
        <RecenterButton onClick={recenter} disabled={!fitCoords.length} />
      </div>

      <div style={{ display: 'flex', gap: 16, marginTop: 4, fontSize: 11, color: 'var(--text-secondary)', flexWrap: 'wrap' }}>
        <span><span style={{ display: 'inline-block', width: 10, height: 10, borderRadius: '50%', background: 'rgb(220,38,38)', marginRight: 4 }} /> Idle trailers (size = idle hours)</span>
        <span><span style={{ display: 'inline-block', width: 10, height: 10, borderRadius: '50%', background: 'rgb(41,121,232)', marginRight: 4 }} /> Demand terminals (size = demand score)</span>
        <span><span style={{ display: 'inline-block', width: 14, height: 3, background: 'rgb(34,197,94)', verticalAlign: 'middle', marginRight: 4 }} /> Reposition route</span>
        <span><span style={{ display: 'inline-block', width: 10, height: 10, background: 'rgba(41,121,232,0.25)', border: '1px solid rgb(41,121,232)', marginRight: 4 }} /> Selected trailer&apos;s reachability ({maxRepositionMinutes} min)</span>
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
                <th style={{ padding: '8px' }}>Subtype</th>
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
                    <td style={{ padding: '6px 8px', fontSize: 11 }}>{tr.VEHICLE_SUBTYPE || '-'}</td>
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
                <tr><td colSpan={8} style={{ padding: 16, textAlign: 'center', color: 'var(--text-secondary)' }}>No idle trailers above threshold. Lower the threshold or generate trucking telemetry via Data Studio.</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      {selectedTrailer && selectedReachability && (
        <div style={{ marginTop: 16 }}>
          <h3 style={{ fontSize: 13, margin: '8px 0' }}>
            Reachability for {selectedTrailer.VEHICLE_ID}{selectedTrailer.VEHICLE_SUBTYPE ? ` [${selectedTrailer.VEHICLE_SUBTYPE}]` : ''} -
            <span style={{ color: '#0DB048', marginLeft: 6 }}>{selectedReachability.reachable.length} reachable</span> /
            <span style={{ color: 'var(--text-secondary)', marginLeft: 6 }}>{selectedReachability.excluded.length} excluded</span>
          </h3>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
            <div style={{ border: '1px solid var(--border)', borderRadius: 8, overflow: 'hidden' }}>
              <div style={{ padding: '6px 10px', background: 'rgba(13,176,72,0.08)', fontSize: 12, fontWeight: 600 }}>Reachable</div>
              <div style={{ maxHeight: 220, overflow: 'auto' }}>
                <table style={{ width: '100%', fontSize: 11, borderCollapse: 'collapse' }}>
                  <thead><tr style={{ textAlign: 'left', background: 'var(--surface)' }}>
                    <th style={{ padding: '4px 8px' }}>Terminal</th><th style={{ padding: '4px 8px' }}>Drive</th><th style={{ padding: '4px 8px' }}>Demand</th>
                  </tr></thead>
                  <tbody>
                    {selectedReachability.reachable.map(t => (
                      <tr key={t.TERMINAL_ID} style={{ borderTop: '1px solid var(--border)' }}>
                        <td style={{ padding: '4px 8px' }}>{t.TERMINAL_NAME} <span style={{ color: 'var(--text-secondary)' }}>({t.LOCATION_TYPE})</span></td>
                        <td style={{ padding: '4px 8px' }}>{Math.round((t.durationSec || 0) / 60)} min{t.distanceM != null ? ` / ${(t.distanceM / 1000).toFixed(1)} km` : ''}</td>
                        <td style={{ padding: '4px 8px' }}>{t.DEMAND_SCORE}</td>
                      </tr>
                    ))}
                    {!selectedReachability.reachable.length && (
                      <tr><td colSpan={3} style={{ padding: 12, color: 'var(--text-secondary)', textAlign: 'center' }}>No terminals reachable in {maxRepositionMinutes} min.</td></tr>
                    )}
                  </tbody>
                </table>
              </div>
            </div>
            <div style={{ border: '1px solid var(--border)', borderRadius: 8, overflow: 'hidden' }}>
              <div style={{ padding: '6px 10px', background: 'rgba(245,158,11,0.08)', fontSize: 12, fontWeight: 600 }}>Excluded</div>
              <div style={{ maxHeight: 220, overflow: 'auto' }}>
                <table style={{ width: '100%', fontSize: 11, borderCollapse: 'collapse' }}>
                  <thead><tr style={{ textAlign: 'left', background: 'var(--surface)' }}>
                    <th style={{ padding: '4px 8px' }}>Terminal</th><th style={{ padding: '4px 8px' }}>Reason</th>
                  </tr></thead>
                  <tbody>
                    {selectedReachability.excluded.map(t => (
                      <tr key={t.TERMINAL_ID} style={{ borderTop: '1px solid var(--border)', color: 'var(--text-secondary)' }}>
                        <td style={{ padding: '4px 8px' }}>{t.TERMINAL_NAME} <span style={{ fontSize: 10 }}>({t.LOCATION_TYPE})</span></td>
                        <td style={{ padding: '4px 8px', fontSize: 10 }} title={reasonTooltip(t.reason, maxRepositionMinutes)}>{reasonLabel(t.reason)}</td>
                      </tr>
                    ))}
                    {!selectedReachability.excluded.length && (
                      <tr><td colSpan={2} style={{ padding: 12, textAlign: 'center', color: 'var(--text-secondary)' }}>All terminals reachable.</td></tr>
                    )}
                  </tbody>
                </table>
              </div>
            </div>
          </div>
        </div>
      )}

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
            <div style={{ fontSize: 10, color: 'var(--text-secondary)', marginTop: 8 }}>Prompt context: ORS road-network matrix (HGV envelope), top-3 reachable demand terminals, skill compatibility, {maxRepositionMinutes}-min shift cap.</div>
          </div>
        </div>
      )}
    </div>
    </PageContainer>
  );
}

function reasonLabel(r: ExclusionReason): string {
  switch (r) {
    case 'OUT_OF_SHIFT': return 'out of shift';
    case 'NOT_ROUTABLE': return 'not routable';
    case 'INCOMPATIBLE_SKILL': return 'skill mismatch';
    case 'NO_DEMAND': return 'no demand';
  }
}
function reasonTooltip(r: ExclusionReason, maxMin: number): string {
  switch (r) {
    case 'OUT_OF_SHIFT': return `Road duration > ${maxMin} min shift cap (per-trailer ORS HGV matrix)`;
    case 'NOT_ROUTABLE': return 'ORS could not snap or route to this terminal in the active region graph';
    case 'INCOMPATIBLE_SKILL': return 'Trailer subtype cannot serve this terminals lane mix (e.g. DRY trailer for REEFER lane)';
    case 'NO_DEMAND': return 'Terminal not in demand list (net outbound trips <= 0)';
  }
}

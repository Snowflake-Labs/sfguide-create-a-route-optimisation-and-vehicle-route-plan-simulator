import { useState, useCallback, useEffect, useMemo, useRef } from 'react';
import DeckGL from '@deck.gl/react';
import { GeoJsonLayer, ScatterplotLayer, BitmapLayer, PathLayer } from '@deck.gl/layers';
import { TileLayer } from '@deck.gl/geo-layers';
import { samplePoints, COORD_FUNCTIONS, type BBox, type SampledPoints } from './function-tester/samplePoints';

import {
  RegionOption, GeoData, OptimizationStop, OptimizationVehicle, OptimizationParsed,
  CARTO_LIGHT, OPTIMIZATION_PALETTE, PROFILE_LABELS, FUNCTIONS,
  cartoBasemap, bboxCenter, offsetPoint, isoRangeFor, isProvisionedRegion, resolveRegionKey,
  generateSql, tryParseJson, decodePolyline, extractGeoData,
  parseMatrixResult, parseOptimizationResult, travelTimeColor, parseIsochroneOrigin,
} from './function-tester/helpers';
import { ResultMap } from './function-tester/ResultMap';

interface RoadPointsResult {
  points: [number, number][] | null;
  reason?: string;
  cached?: boolean;
}

async function fetchRoadPoints(bbox: BBox, profile: string, opts?: { nocache?: boolean; region?: string }): Promise<RoadPointsResult> {
  try {
    const params = new URLSearchParams({
      min_lat: bbox.min_lat.toString(),
      max_lat: bbox.max_lat.toString(),
      min_lon: bbox.min_lon.toString(),
      max_lon: bbox.max_lon.toString(),
      limit: '50',
      profile,
    });
    if (opts?.nocache) params.set('nocache', '1');
    if (opts?.region && opts.region !== 'default') params.set('region', opts.region);
    const resp = await fetch(`/api/sample-road-points?${params}`);
    const data = await resp.json();
    if (data.ok && data.points?.length > 0) {
      return { points: data.points, cached: data.cached };
    }
    return { points: null, reason: data.reason || 'no road points returned' };
  } catch (e: any) {
    return { points: null, reason: e?.message || 'network error' };
  }
}

export default function FunctionTester() {
  const [regions, setRegions] = useState<RegionOption[]>([]);
  const [selectedRegion, setSelectedRegion] = useState<RegionOption | null>(null);
  const [regionsLoading, setRegionsLoading] = useState(true);
  const [regionsError, setRegionsError] = useState<string | null>(null);
  const [selectedFn, setSelectedFn] = useState('ORS_STATUS');
  const [selectedProfile, setSelectedProfile] = useState('driving-car');
  const [availableProfiles, setAvailableProfiles] = useState<string[]>([]);
  const [profilesLoading, setProfilesLoading] = useState(false);
  const [sfDatabase, setSfDatabase] = useState('');
  const [sqlInput, setSqlInput] = useState('SELECT CORE.ORS_STATUS()');
  const [result, setResult] = useState<any>(null);
  const [error, setError] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  const [duration, setDuration] = useState<number | null>(null);
  const [roadPoints, setRoadPoints] = useState<[number, number][] | null>(null);
  const [roadPointsReason, setRoadPointsReason] = useState<string | null>(null);
  const [overtureAvailable, setOvertureAvailable] = useState<boolean | null>(null);
  const [sampleHint, setSampleHint] = useState<string | null>(null);
  const [lastExecutedSql, setLastExecutedSql] = useState('');
  const userEditedRef = useRef(false);

  const regeneratePoints = useCallback((fnName: string, region: RegionOption | null, profile: string, db: string, roads?: [number, number][] | null) => {
    if (!COORD_FUNCTIONS.includes(fnName)) {
      setSampleHint(null);
      setSqlInput(generateSql(fnName, region, profile, db, null));
      return;
    }
    const bbox = region?.bbox;
    if (!bbox || (bbox.min_lat === 0 && bbox.max_lat === 0 && bbox.min_lon === 0 && bbox.max_lon === 0)) {
      setSampleHint(null);
      setSqlInput(generateSql(fnName, region, profile, db, null));
      return;
    }
    const sampled = samplePoints({
      fnName, bbox, profile,
      roadPoints: roads || undefined,
      boundary: region?.boundaryGeoJson || undefined,
    });
    setSampleHint(sampled?.hint || null);
    setSqlInput(generateSql(fnName, region, profile, db, sampled));
    userEditedRef.current = false;
  }, []);

  useEffect(() => {
    (async () => {
      let db = '';
      try {
        const cr = await fetch('/api/config');
        const cfg = await cr.json();
        db = cfg.database || '';
        setSfDatabase(db);
      } catch {}

      let probeOvertureOk = false;
      try {
        const probeResp = await fetch('/api/diagnostics/probe');
        const probeData = await probeResp.json();
        probeOvertureOk = probeData.overtureTransportation?.ok === true;
        setOvertureAvailable(probeOvertureOk);
      } catch {
        setOvertureAvailable(false);
      }

      try {
        const r = await fetch('/api/regions/provisioned');
        const data = await r.json();
        if (data.error) setRegionsError(data.error);
        const regionList: RegionOption[] = (data.regions || []).map((reg: any) => {
          // Parse boundary GeoJSON string from REGION_CATALOG.BOUNDARY into an
          // object so samplePoints can run polygon rejection sampling. Skip
          // silently on parse error — falls back to bbox-only sampling.
          if (reg && typeof reg.boundaryGeoJson === 'string') {
            try {
              const parsed = JSON.parse(reg.boundaryGeoJson);
              if (parsed && (parsed.type === 'Polygon' || parsed.type === 'MultiPolygon')) {
                return { ...reg, boundaryGeoJson: parsed };
              }
              return { ...reg, boundaryGeoJson: null };
            } catch {
              return { ...reg, boundaryGeoJson: null };
            }
          }
          return reg;
        });
        setRegions(regionList);
        const def = regionList.find((c) => c.isDefault) || regionList[0];
        if (def) {
          setSelectedRegion(def);
          let roads: [number, number][] | null = null;
          if (probeOvertureOk && def.bbox) {
            const r = await fetchRoadPoints(def.bbox, 'driving-car', { region: def.region });
            roads = r.points;
            setRoadPoints(roads);
            setRoadPointsReason(roads ? null : (r.reason || 'no road points'));
          }
          setSqlInput(generateSql('ORS_STATUS', def, 'driving-car', db));
        }
      } catch (err: any) {
        setRegionsError(err.message || 'Failed to load regions');
      }
      setRegionsLoading(false);
    })();
  }, []);

  const fetchProfiles = useCallback(async (region: RegionOption | null) => {
    setProfilesLoading(true);
    try {
      const pfx = sfDatabase ? `${sfDatabase}.CORE` : 'CORE';
      const resolved = resolveRegionKey(region);
      const rg = resolved ? `'${resolved}'` : 'NULL::VARCHAR';
      const statusSql = `SELECT ${pfx}.ORS_STATUS(${rg})`;
      const resp = await fetch('/api/query', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sql: statusSql }),
      });
      const data = await resp.json();
      if (data.result?.[0]) {
        const raw = Object.values(data.result[0])[0];
        const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
        if (parsed?.profiles && typeof parsed.profiles === 'object') {
          const names = Object.keys(parsed.profiles).filter((p: string) => parsed.profiles[p]?.encoder_name);
          if (names.length > 0) {
            setAvailableProfiles(names);
            if (!names.includes(selectedProfile)) {
              setSelectedProfile(names[0]);
              regeneratePoints(selectedFn, region, names[0], sfDatabase, roadPoints);
            }
            setProfilesLoading(false);
            return;
          }
        }
      }
    } catch {}
    setAvailableProfiles([]);
    setProfilesLoading(false);
  }, [selectedFn, selectedProfile, sfDatabase, roadPoints, regeneratePoints]);

  useEffect(() => {
    if (selectedRegion) fetchProfiles(selectedRegion);
  }, [selectedRegion]);

  const onRegionChange = useCallback(async (regionKey: string) => {
    const r = regions.find((c) => c.region === regionKey) || null;
    setSelectedRegion(r);
    userEditedRef.current = false;
    let roads: [number, number][] | null = null;
    if (overtureAvailable && r?.bbox) {
      const rp = await fetchRoadPoints(r.bbox, selectedProfile, { region: r.region });
      roads = rp.points;
      setRoadPoints(roads);
      setRoadPointsReason(roads ? null : (rp.reason || 'no road points'));
    } else {
      setRoadPoints(null);
      setRoadPointsReason(null);
    }
    regeneratePoints(selectedFn, r, selectedProfile, sfDatabase, roads);
  }, [regions, selectedFn, selectedProfile, sfDatabase, overtureAvailable, regeneratePoints]);

  const onFnChange = useCallback((fnName: string) => {
    setSelectedFn(fnName);
    userEditedRef.current = false;
    regeneratePoints(fnName, selectedRegion, selectedProfile, sfDatabase, roadPoints);
  }, [selectedRegion, selectedProfile, sfDatabase, roadPoints, regeneratePoints]);

  const onProfileChange = useCallback(async (profile: string) => {
    setSelectedProfile(profile);
    userEditedRef.current = false;
    let roads: [number, number][] | null = roadPoints;
    if (overtureAvailable && selectedRegion?.bbox) {
      const rp = await fetchRoadPoints(selectedRegion.bbox, profile, { region: selectedRegion.region });
      roads = rp.points;
      setRoadPoints(roads);
      setRoadPointsReason(roads ? null : (rp.reason || 'no road points'));
    }
    regeneratePoints(selectedFn, selectedRegion, profile, sfDatabase, roads);
  }, [selectedRegion, selectedFn, sfDatabase, roadPoints, overtureAvailable, regeneratePoints]);

  const handleReshuffle = useCallback(async () => {
    userEditedRef.current = false;
    let roads = roadPoints;
    if (overtureAvailable && selectedRegion?.bbox) {
      const rp = await fetchRoadPoints(selectedRegion.bbox, selectedProfile, { nocache: true, region: selectedRegion.region });
      roads = rp.points;
      setRoadPoints(roads);
      setRoadPointsReason(roads ? null : (rp.reason || 'no road points'));
    }
    regeneratePoints(selectedFn, selectedRegion, selectedProfile, sfDatabase, roads);
  }, [selectedFn, selectedRegion, selectedProfile, sfDatabase, roadPoints, overtureAvailable, regeneratePoints]);

  const handleSqlChange = useCallback((e: React.ChangeEvent<HTMLTextAreaElement>) => {
    userEditedRef.current = true;
    setSqlInput(e.target.value);
  }, []);

  const executeQuery = useCallback(async () => {
    setRunning(true);
    setResult(null);
    setError(null);
    setLastExecutedSql(sqlInput);
    const start = Date.now();
    try {
      const resp = await fetch('/api/query', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sql: sqlInput }),
      });
      const data = await resp.json();
      setDuration(Date.now() - start);
      if (data.error) setError(data.error);
      else setResult(data.result);
    } catch (err: any) {
      setDuration(Date.now() - start);
      setError(err.message);
    }
    setRunning(false);
  }, [sqlInput]);

  return (
    <div className="panel">
      <h2>Function Tester</h2>
      <p className="subtitle">Test ORS routing functions against any provisioned region</p>

      <h3>Region</h3>
      <select
        className="select"
        value={selectedRegion?.region || ''}
        onChange={(e) => onRegionChange(e.target.value)}
      >
        {regionsLoading && <option value="">Loading regions...</option>}
        {!regionsLoading && regions.length === 0 && <option value="">No regions provisioned</option>}
        {regions.map((c) => (
          <option key={c.region} value={c.region}>
            {c.display_name || c.region}
            {c.isDefault ? '' : ` (${c.region})`}
          </option>
        ))}
      </select>
      {regionsError && (
        <p style={{ color: 'var(--error)', fontSize: 13, margin: '4px 0 0' }}>{regionsError}</p>
      )}
      {selectedRegion && (!selectedRegion.bbox || selectedRegion.bbox.min_lat == null) && (
        <p style={{ color: 'var(--warning, #f0ad4e)', fontSize: 13, margin: '4px 0 0' }}>
          Bounding box unavailable for this region. Coordinates in generated SQL may be incorrect.
        </p>
      )}

      <h3>Routing Profile</h3>
      <select
        className="select"
        value={selectedProfile}
        onChange={(e) => onProfileChange(e.target.value)}
        disabled={profilesLoading}
      >
        {profilesLoading && <option value="">Loading profiles...</option>}
        {!profilesLoading && availableProfiles.length === 0 && <option value="driving-car">driving-car</option>}
        {!profilesLoading && availableProfiles.map((p) => (
          <option key={p} value={p}>{PROFILE_LABELS[p] || p}</option>
        ))}
      </select>

      <h3>Function</h3>
      <div className="fn-grid">
        {FUNCTIONS.map((fn) => (
          <button
            key={fn.name}
            className={`fn-card ${selectedFn === fn.name ? 'active' : ''}`}
            onClick={() => onFnChange(fn.name)}
          >
            <div className="fn-name">{fn.name}</div>
            <div className="fn-sig">{fn.sig}</div>
          </button>
        ))}
      </div>

      <h3>SQL Query</h3>
      <textarea
        className="sql-editor"
        value={sqlInput}
        onChange={handleSqlChange}
        rows={Math.max(3, sqlInput.split('\n').length)}
        spellCheck={false}
      />
      {sampleHint && (
        <p style={{ color: 'var(--warning, #f0ad4e)', fontSize: 12, margin: '4px 0 0' }}>{sampleHint}</p>
      )}
      {COORD_FUNCTIONS.includes(selectedFn) && overtureAvailable && roadPoints && roadPoints.length > 0 && (
        <p style={{ color: 'var(--text-secondary)', fontSize: 12, margin: '4px 0 0' }}>
          Snapped to {roadPoints.length} Overture road point{roadPoints.length === 1 ? '' : 's'} for region.
        </p>
      )}
      {COORD_FUNCTIONS.includes(selectedFn) && overtureAvailable && roadPointsReason && (!roadPoints || roadPoints.length === 0) && (
        <p style={{ color: 'var(--warning, #f0ad4e)', fontSize: 12, margin: '4px 0 0' }}>
          Couldn't snap to roads ({roadPointsReason}) — recommended point may be outside the active graph.
        </p>
      )}
      {overtureAvailable === false && COORD_FUNCTIONS.includes(selectedFn) && (
        <p style={{ color: 'var(--text-secondary)', fontSize: 12, margin: '4px 0 0', fontStyle: 'italic' }}>
          Install Overture Maps Transportation for road-snapped sample points.
        </p>
      )}
      <div className="action-row">
        <button className="btn primary" onClick={executeQuery} disabled={running || !sqlInput.trim()}>
          {running ? 'Running...' : 'Execute'}
        </button>
        <button
          className="btn secondary"
          onClick={handleReshuffle}
          disabled={!COORD_FUNCTIONS.includes(selectedFn)}
          title="Generate new random sample points for this region and profile."
        >
          Reshuffle points
        </button>
        {duration !== null && <span className="duration">{duration}ms</span>}
      </div>

      {error && (
        <div className="error-banner">
          <strong>Error:</strong> {error}
        </div>
      )}

      {result !== null && <ResultMap result={result} fnName={selectedFn} regionCenter={bboxCenter(selectedRegion?.bbox)} executedSql={lastExecutedSql} />}

      {result !== null && (selectedFn === 'MATRIX' || selectedFn === 'MATRIX_TABULAR') && (() => {
        const raw = result?.[0] ? Object.values(result[0])[0] : null;
        const parsed = raw ? (typeof raw === 'string' ? (() => { try { return JSON.parse(raw); } catch { return null; } })() : raw) : null;
        if (!parsed?.durations && !parsed?.distances) return null;
        const srcs: any[] = parsed.sources || [{ name: 'Origin' }];
        const dsts: any[] = parsed.destinations || [];
        const durations: number[][] = parsed.durations || [];
        const distances: number[][] = parsed.distances || [];
        const srcLabel = (s: any, i: number) => s.name || `[${s.location?.[0]?.toFixed(3)}, ${s.location?.[1]?.toFixed(3)}]` || `Origin ${i + 1}`;
        const dstLabel = (d: any, i: number) => d.name || `[${d.location?.[0]?.toFixed(3)}, ${d.location?.[1]?.toFixed(3)}]` || `Dest ${i + 1}`;
        const cellStyle = { padding: '6px 12px', border: '1px solid var(--border)', textAlign: 'right' as const };
        const headStyle = { padding: '6px 12px', background: 'var(--surface-alt)', border: '1px solid var(--border)', whiteSpace: 'nowrap' as const, fontWeight: 600 };
        return (
          <div className="result-panel" style={{ overflowX: 'auto' }}>
            <h3>Matrix Result</h3>
            {durations.length > 0 && (
              <div style={{ marginBottom: 20 }}>
                <h4 style={{ fontSize: 13, color: 'var(--text-secondary)', marginBottom: 6 }}>Travel Time (minutes)</h4>
                <table style={{ borderCollapse: 'collapse', fontSize: 12 }}>
                  <thead><tr>
                    <th style={headStyle}>From \ To</th>
                    {dsts.map((d: any, i: number) => <th key={i} style={headStyle}>{dstLabel(d, i)}</th>)}
                  </tr></thead>
                  <tbody>{durations.map((row: number[], i: number) => (
                    <tr key={i}>
                      <td style={{ ...cellStyle, fontWeight: 600, textAlign: 'left' }}>{srcLabel(srcs[i], i)}</td>
                      {row.map((v: number, j: number) => <td key={j} style={cellStyle}>{(v / 60).toFixed(1)} min</td>)}
                    </tr>
                  ))}</tbody>
                </table>
              </div>
            )}
            {distances.length > 0 && (
              <div>
                <h4 style={{ fontSize: 13, color: 'var(--text-secondary)', marginBottom: 6 }}>Distance (km)</h4>
                <table style={{ borderCollapse: 'collapse', fontSize: 12 }}>
                  <thead><tr>
                    <th style={headStyle}>From \ To</th>
                    {dsts.map((d: any, i: number) => <th key={i} style={headStyle}>{dstLabel(d, i)}</th>)}
                  </tr></thead>
                  <tbody>{distances.map((row: number[], i: number) => (
                    <tr key={i}>
                      <td style={{ ...cellStyle, fontWeight: 600, textAlign: 'left' }}>{srcLabel(srcs[i], i)}</td>
                      {row.map((v: number, j: number) => <td key={j} style={cellStyle}>{(v / 1000).toFixed(2)} km</td>)}
                    </tr>
                  ))}</tbody>
                </table>
              </div>
            )}
          </div>
        );
      })()}

      {result !== null && selectedFn !== 'MATRIX' && selectedFn !== 'MATRIX_TABULAR' && (
        <div className="result-panel">
          <h3>Result</h3>
          <pre className="result-json">{typeof result === 'string' ? result : JSON.stringify(result, null, 2)}</pre>
        </div>
      )}
      {result !== null && (selectedFn === 'MATRIX' || selectedFn === 'MATRIX_TABULAR') && (
        <details style={{ marginTop: 8 }}>
          <summary style={{ fontSize: 12, color: 'var(--text-secondary)', cursor: 'pointer' }}>Raw JSON</summary>
          <pre className="result-json" style={{ fontSize: 11 }}>{JSON.stringify(result, null, 2)}</pre>
        </details>
      )}
    </div>
  );
}

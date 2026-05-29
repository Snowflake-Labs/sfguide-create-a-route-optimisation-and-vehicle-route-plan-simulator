import { useState, useCallback, useEffect, useRef } from 'react';
import { samplePoints, COORD_FUNCTIONS, type BBox } from './function-tester/samplePoints';

import {
  RegionOption, PROFILE_LABELS, FUNCTIONS,
  bboxCenter, generateSql,
} from './function-tester/helpers';
import { ResultMap } from './function-tester/ResultMap';
import { useActivePreset } from '../hooks/useActivePreset';
import PresetRoutingControls from '../shared/PresetRoutingControls';

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
    if (opts?.region) params.set('region', opts.region);
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
  const preset = useActivePreset();
  const [regions, setRegions] = useState<RegionOption[]>([]);
  const [selectedRegion, setSelectedRegion] = useState<RegionOption | null>(null);
  const [regionsLoading, setRegionsLoading] = useState(true);
  const [regionsError, setRegionsError] = useState<string | null>(null);
  const [selectedFn, setSelectedFn] = useState('ORS_STATUS');
  const [selectedProfile, setSelectedProfile] = useState(preset.orsProfile);
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
  const [roadNonce, setRoadNonce] = useState(0);
  const [sampleNonce, setSampleNonce] = useState(0);
  const userEditedRef = useRef(false);
  const lastPresetRegionRef = useRef<string | null>(null);
  const lastPresetProfileRef = useRef<string | null>(null);
  const roadSeqRef = useRef(0);
  const profilesSeqRef = useRef(0);
  const nocacheNextRef = useRef(false);
  const profilesCacheRef = useRef<Map<string, string[]>>(new Map());

  useEffect(() => {
    (async () => {
      try {
        const cr = await fetch('/api/config');
        const cfg = await cr.json();
        setSfDatabase(cfg.database || '');
      } catch {}

      try {
        const probeResp = await fetch('/api/diagnostics/probe');
        const probeData = await probeResp.json();
        setOvertureAvailable(probeData.overtureTransportation?.ok === true);
      } catch {
        setOvertureAvailable(false);
      }

      try {
        const r = await fetch('/api/regions/provisioned');
        const data = await r.json();
        if (data.error) setRegionsError(data.error);
        const regionList: RegionOption[] = (data.regions || []).map((reg: any) => {
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
        const def =
          regionList.find((c) => c.region === preset.region) ||
          regionList.find((c) => c.isDefault) ||
          regionList[0];
        const initProfile = preset.orsProfile || 'driving-car';
        if (def) {
          setSelectedRegion(def);
          setSelectedProfile(initProfile);
          lastPresetRegionRef.current = preset.region;
          lastPresetProfileRef.current = initProfile;
        }
      } catch (err: any) {
        setRegionsError(err.message || 'Failed to load regions');
      }
      setRegionsLoading(false);
    })();
  }, []);

  useEffect(() => {
    const region = selectedRegion;
    const profile = selectedProfile;
    const bbox = region?.bbox;

    if (overtureAvailable !== true || !bbox || !region) {
      setRoadPoints(null);
      setRoadPointsReason(null);
      return;
    }

    setRoadPoints(null);
    setRoadPointsReason(null);

    const mySeq = ++roadSeqRef.current;
    const nocache = nocacheNextRef.current;
    nocacheNextRef.current = false;

    (async () => {
      const rp = await fetchRoadPoints(bbox, profile, { region: region.region, nocache });
      if (mySeq !== roadSeqRef.current) return;
      setRoadPoints(rp.points);
      setRoadPointsReason(rp.points ? null : (rp.reason || 'no road points'));
    })();
  }, [selectedRegion, selectedProfile, overtureAvailable, roadNonce]);

  useEffect(() => {
    if (userEditedRef.current) return;

    const fnName = selectedFn;
    const region = selectedRegion;
    const profile = selectedProfile;
    const db = sfDatabase;
    const roads = roadPoints;

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
      fnName,
      bbox,
      profile,
      roadPoints: roads || undefined,
      boundary: region?.boundaryGeoJson || undefined,
      seed: sampleNonce,
    });
    setSampleHint(sampled?.hint || null);
    setSqlInput(generateSql(fnName, region, profile, db, sampled));
  }, [selectedFn, selectedRegion, selectedProfile, sfDatabase, roadPoints, sampleNonce]);

  const fetchProfiles = useCallback(async (region: RegionOption | null) => {
    const regionKey = region?.region;
    if (!regionKey) {
      setAvailableProfiles([]);
      return;
    }

    const mySeq = ++profilesSeqRef.current;

    const cached = profilesCacheRef.current.get(regionKey);
    if (cached) {
      if (mySeq !== profilesSeqRef.current) return;
      setAvailableProfiles(cached);
      if (!cached.includes(selectedProfile)) {
        userEditedRef.current = false;
        setSelectedProfile(cached[0]);
      }
      return;
    }

    setProfilesLoading(true);
    try {
      const pfx = sfDatabase ? `${sfDatabase}.CORE` : 'CORE';
      const rg = `'${regionKey}'`;
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
            if (mySeq !== profilesSeqRef.current) return;
            profilesCacheRef.current.set(regionKey, names);
            setAvailableProfiles(names);
            if (!names.includes(selectedProfile)) {
              userEditedRef.current = false;
              setSelectedProfile(names[0]);
            }
            setProfilesLoading(false);
            return;
          }
        }
      }
    } catch {}
    if (mySeq !== profilesSeqRef.current) return;
    setAvailableProfiles([]);
    setProfilesLoading(false);
  }, [selectedProfile, sfDatabase]);

  useEffect(() => {
    if (selectedRegion) fetchProfiles(selectedRegion);
  }, [selectedRegion, fetchProfiles]);

  const onRegionChange = useCallback((regionKey: string) => {
    const r = regions.find((c) => c.region === regionKey) || null;
    userEditedRef.current = false;
    setSelectedRegion(r);
  }, [regions]);

  const onFnChange = useCallback((fnName: string) => {
    userEditedRef.current = false;
    setSelectedFn(fnName);
  }, []);

  const onProfileChange = useCallback((profile: string) => {
    userEditedRef.current = false;
    setSelectedProfile(profile);
  }, []);

  useEffect(() => {
    if (preset.loading || regions.length === 0 || !preset.region) return;
    if (lastPresetRegionRef.current === preset.region) return;
    lastPresetRegionRef.current = preset.region;
    const match = regions.find((c) => c.region === preset.region);
    if (match) onRegionChange(match.region);
  }, [preset.region, preset.loading, regions, onRegionChange]);

  useEffect(() => {
    if (preset.loading || !preset.orsProfile) return;
    if (lastPresetProfileRef.current === preset.orsProfile) return;
    if (availableProfiles.length > 0 && !availableProfiles.includes(preset.orsProfile)) return;
    lastPresetProfileRef.current = preset.orsProfile;
    onProfileChange(preset.orsProfile);
  }, [preset.orsProfile, preset.loading, availableProfiles, onProfileChange]);

  const handleReshuffle = useCallback(() => {
    userEditedRef.current = false;
    nocacheNextRef.current = true;
    setRoadNonce((n) => n + 1);
    setSampleNonce((n) => n + 1);
  }, []);

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

      <h3>Region &amp; routing profile</h3>
      {regionsLoading ? (
        <p style={{ fontSize: 13, color: 'var(--text-secondary)' }}>Loading regions...</p>
      ) : regions.length === 0 ? (
        <p style={{ fontSize: 13, color: 'var(--text-secondary)' }}>No regions provisioned</p>
      ) : (
        <PresetRoutingControls
          region={selectedRegion?.region || preset.region}
          profile={selectedProfile}
          onChange={({ region, profile }) => {
            if (region !== selectedRegion?.region) onRegionChange(region);
            if (profile !== selectedProfile) onProfileChange(profile);
          }}
          regions={regions.map((c) => ({
            value: c.region,
            label: c.display_name || c.region,
          }))}
          profiles={
            profilesLoading
              ? [{ value: selectedProfile, label: 'Loading...' }]
              : availableProfiles.length > 0
                ? availableProfiles.map((p) => ({ value: p, label: PROFILE_LABELS[p] || p }))
                : [{ value: preset.orsProfile, label: PROFILE_LABELS[preset.orsProfile] || preset.orsProfile }]
          }
        />
      )}
      {regionsError && (
        <p style={{ color: 'var(--error)', fontSize: 13, margin: '4px 0 0' }}>{regionsError}</p>
      )}
      {selectedRegion && (!selectedRegion.bbox || selectedRegion.bbox.min_lat == null) && (
        <p style={{ color: 'var(--warning, #f0ad4e)', fontSize: 13, margin: '4px 0 0' }}>
          Bounding box unavailable for this region. Coordinates in generated SQL may be incorrect.
        </p>
      )}

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

      {result !== null && <ResultMap
        result={result}
        fnName={selectedFn}
        regionCenter={bboxCenter(selectedRegion?.bbox)}
        regionBbox={selectedRegion?.bbox ?? null}
        regionBoundary={selectedRegion?.boundaryGeoJson ?? null}
        executedSql={lastExecutedSql}
      />}

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

import React, { useState, useEffect, useCallback, useRef } from 'react';
import type { MatrixEstimate, MatrixBuildStatus, RegionInfo } from '../types';

const RES_LABELS: Record<number, string> = {
  9: 'Last Mile (174m)',
  8: 'Delivery Zone (460m)',
  7: 'Long Range (1.2km)',
};

const RES_CUTOFFS: Record<number, number> = { 9: 2, 8: 10, 7: 50 };
const RATE_PAIRS_PER_SEC = 31500;
const CREDIT_PER_HOUR_SMALL = 2;

function estimateHexCount(bounds: RegionInfo['bounds'], res: number): number {
  const area = (bounds.maxLat - bounds.minLat) * (bounds.maxLon - bounds.minLon);
  if (res === 9) return Math.round(area * 90000);
  if (res === 8) return Math.round(area * 13500);
  return Math.round(area * 2000);
}

function estimatePairs(hexCount: number, res: number): number {
  const kRing = res === 7 ? 33 : res === 8 ? 17 : 9;
  return hexCount * Math.min(hexCount - 1, kRing * 6);
}

function formatNumber(n: number): string {
  if (n >= 1_000_000_000) return (n / 1_000_000_000).toFixed(1) + 'B';
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M';
  if (n >= 1_000) return (n / 1_000).toFixed(1) + 'K';
  return n.toLocaleString();
}

function formatDuration(minutes: number): string {
  if (minutes < 1) return `${Math.round(minutes * 60)}s`;
  if (minutes < 60) return `${Math.round(minutes)} min`;
  const hrs = Math.floor(minutes / 60);
  const mins = Math.round(minutes % 60);
  return mins > 0 ? `${hrs}h ${mins}m` : `${hrs}h`;
}

function formatCost(cost: number): string {
  if (cost >= 1000) return `$${(cost / 1000).toFixed(1)}K`;
  return `$${cost.toFixed(2)}`;
}

const STAGE_STEPS = [
  { key: 'HEXAGONS_READY', label: 'Hexagons', icon: '⬡' },
  { key: 'QUEUED', label: 'Work Queue', icon: '📋' },
  { key: 'BUILDING', label: 'API Calls', icon: '⟳' },
  { key: 'FLATTENING', label: 'Flatten', icon: '⚡' },
  { key: 'COMPLETE', label: 'Complete', icon: '✓' },
];

function getStageIndex(stage: string): number {
  if (stage === 'NOT_STARTED' || stage === 'STARTING') return -1;
  const idx = STAGE_STEPS.findIndex((s) => s.key === stage);
  return idx >= 0 ? idx : -1;
}

export default function MatrixBuilder() {
  const [regions, setRegions] = useState<RegionInfo[]>([]);
  const [loadingRegions, setLoadingRegions] = useState(true);
  const [selectedRegion, setSelectedRegion] = useState<string>('');
  const [selectedRes, setSelectedRes] = useState<Set<number>>(new Set([9, 8, 7]));
  const [buildStatus, setBuildStatus] = useState<MatrixBuildStatus[]>([]);
  const [isBuilding, setIsBuilding] = useState(false);
  const [existingCounts, setExistingCounts] = useState<Record<string, number>>({});
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const fetchRegions = useCallback(async () => {
    setLoadingRegions(true);
    try {
      const r = await fetch('/api/matrix/regions');
      const data = await r.json();
      const fetched: RegionInfo[] = data.regions || [];
      setRegions(fetched);
      if (fetched.length > 0 && !selectedRegion) {
        const running = fetched.find((r) => r.serviceStatus === 'RUNNING');
        setSelectedRegion((running || fetched[0]).region);
      }
    } catch {}
    setLoadingRegions(false);
  }, []);

  const refreshExisting = useCallback(() => {
    const params = selectedRegion ? `?region=${selectedRegion}` : '';
    fetch(`/api/matrix/existing${params}`)
      .then((r) => r.json())
      .then(setExistingCounts)
      .catch(() => {});
  }, [selectedRegion]);

  useEffect(() => { fetchRegions(); return () => { if (pollRef.current) clearInterval(pollRef.current); }; }, [fetchRegions]);
  useEffect(() => { if (selectedRegion) refreshExisting(); }, [selectedRegion, refreshExisting]);

  const region = regions.find((r) => r.region === selectedRegion);

  const hexEstimates = React.useMemo(() => {
    if (!region) return [];
    return [9, 8, 7].map((res) => {
      const hexagons = estimateHexCount(region.bounds, res);
      return { res, hexagons, pairs: estimatePairs(hexagons, res) };
    });
  }, [region]);

  const estimate = React.useMemo(() => {
    const resolutions = hexEstimates.filter((h) => selectedRes.has(h.res)).map((h) => {
      const timeMin = h.pairs / RATE_PAIRS_PER_SEC / 60;
      return { res: h.res, label: RES_LABELS[h.res], hexagons: h.hexagons, cutoff_miles: RES_CUTOFFS[h.res], sparse_pairs: h.pairs, est_time_minutes: timeMin, est_credits: (timeMin / 60) * CREDIT_PER_HOUR_SMALL };
    });
    const totalTime = resolutions.reduce((s, r) => s + r.est_time_minutes, 0);
    const totalPairs = resolutions.reduce((s, r) => s + r.sparse_pairs, 0);
    return {
      region: region?.label || '', resolutions, total_pairs: totalPairs, total_time_minutes: totalTime,
      total_credits: (totalTime / 60) * CREDIT_PER_HOUR_SMALL, snowflake_cost: ((totalTime / 60) * CREDIT_PER_HOUR_SMALL) * 2.5,
      api_comparison: [
        { provider: 'Google Distance Matrix', cost_per_call: 0.005, calls_needed: totalPairs, total_cost: totalPairs * 0.005 },
        { provider: 'HERE Matrix Routing', cost_per_call: 0.0035, calls_needed: totalPairs, total_cost: totalPairs * 0.0035 },
        { provider: 'Mapbox Matrix API', cost_per_call: 0.0004, calls_needed: totalPairs, total_cost: totalPairs * 0.0004 },
      ],
    } as MatrixEstimate;
  }, [hexEstimates, selectedRes, region]);

  const toggleRes = (res: number) => setSelectedRes((prev) => { const next = new Set(prev); if (next.has(res)) next.delete(res); else next.add(res); return next; });

  const startBuild = useCallback(async () => {
    if (!selectedRegion) return;
    setIsBuilding(true);
    setBuildStatus([]);
    try {
      const res = await fetch('/api/matrix/build', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ region: selectedRegion, resolutions: Array.from(selectedRes).sort() }),
      });
      const data = await res.json();
      if (data.status === 'started') {
        pollRef.current = setInterval(async () => {
          try {
            const sr = await fetch(`/api/matrix/status?region=${selectedRegion}`);
            const sd = await sr.json();
            setBuildStatus(sd.resolutions || []);
            if ((sd.resolutions || []).every((r: any) => r.status === 'complete' || r.status === 'error')) {
              if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; }
              setIsBuilding(false);
              refreshExisting();
            }
          } catch {}
        }, 5000);
      }
    } catch {
      setIsBuilding(false);
    }
  }, [selectedRegion, selectedRes, refreshExisting]);

  const readyRegions = regions.filter((r) => r.ready);

  return (
    <div className="panel">
      <h2>Travel Time Matrix Builder</h2>
      <p className="subtitle">Pre-compute driving times between H3 hexagons using OpenRouteService</p>

      <h3>1. Select Region</h3>
      {loadingRegions ? (
        <div className="loading-text">Checking provisioned ORS regions...</div>
      ) : readyRegions.length === 0 ? (
        <div className="empty-state">No ORS regions provisioned. Use the Cities tab to deploy a region first.</div>
      ) : (
        <div className="region-grid">
          {readyRegions.map((r) => (
            <button key={r.region} className={`region-card ${selectedRegion === r.region ? 'active' : ''}`} onClick={() => setSelectedRegion(r.region)}>
              <span className={`dot ${r.serviceStatus === 'RUNNING' ? 'green' : 'yellow'}`} />
              <div>
                <div className="region-name">{r.label}</div>
                <div className="region-detail">ORS {r.serviceStatus}</div>
              </div>
            </button>
          ))}
        </div>
      )}

      {region && (
        <>
          <h3>2. Select Resolutions</h3>
          <div className="res-grid">
            {hexEstimates.map((h) => (
              <label key={h.res} className={`res-card ${selectedRes.has(h.res) ? 'active' : ''}`}>
                <input type="checkbox" checked={selectedRes.has(h.res)} onChange={() => toggleRes(h.res)} />
                <div>
                  <div className="res-label">Res {h.res} — {RES_LABELS[h.res]}</div>
                  <div className="res-detail">~{formatNumber(h.hexagons)} hexagons · {RES_CUTOFFS[h.res]}mi cutoff · ~{formatNumber(h.pairs)} pairs</div>
                </div>
              </label>
            ))}
          </div>

          <h3>3. Resource Estimate</h3>
          <div className="estimate-grid">
            <div className="estimate-card primary"><div className="estimate-label">Total Pairs</div><div className="estimate-value">~{formatNumber(estimate.total_pairs)}</div></div>
            <div className="estimate-card"><div className="estimate-label">Est. Time</div><div className="estimate-value">{formatDuration(estimate.total_time_minutes)}</div></div>
            <div className="estimate-card"><div className="estimate-label">Credits</div><div className="estimate-value">{estimate.total_credits.toFixed(1)}</div></div>
            <div className="estimate-card highlight"><div className="estimate-label">Est. Cost</div><div className="estimate-value">{formatCost(estimate.snowflake_cost)}</div></div>
          </div>

          <h3>4. Cost Comparison</h3>
          <table className="services-table">
            <thead><tr><th>Provider</th><th>Cost/Element</th><th>Total Cost</th><th>vs Snowflake</th></tr></thead>
            <tbody>
              {estimate.api_comparison.map((api) => {
                const saving = api.total_cost > 0 ? ((api.total_cost - estimate.snowflake_cost) / api.total_cost * 100) : 0;
                return (
                  <tr key={api.provider}>
                    <td>{api.provider}</td>
                    <td>{formatCost(api.cost_per_call)}</td>
                    <td>{formatCost(api.total_cost)}</td>
                    <td>{saving > 0 ? <span className="savings">{saving.toFixed(0)}% cheaper</span> : '—'}</td>
                  </tr>
                );
              })}
              <tr className="highlight-row"><td><strong>Snowflake + ORS</strong></td><td>—</td><td><strong>{formatCost(estimate.snowflake_cost)}</strong></td><td>Baseline</td></tr>
            </tbody>
          </table>
        </>
      )}

      {buildStatus.length > 0 && (
        <>
          <h3>Build Progress</h3>
          {buildStatus.map((bs) => {
            const stageIdx = getStageIndex(bs.stage || 'NOT_STARTED');
            return (
              <div key={bs.resolution} className="progress-card">
                <div className="progress-header">
                  <span>Resolution {bs.resolution} — {RES_LABELS[bs.resolution] || ''}</span>
                  <span className={`badge ${bs.status === 'complete' ? 'ok' : bs.status === 'error' ? 'error' : 'warn'}`}>{bs.stage || bs.status}</span>
                </div>
                <div className="stage-pipeline">
                  {STAGE_STEPS.map((step, i) => (
                    <div key={step.key} className={`stage-step ${i === stageIdx ? 'active' : ''} ${i < stageIdx ? 'done' : ''}`}>
                      <span>{i < stageIdx ? '✓' : step.icon}</span>
                      <span>{step.label}</span>
                    </div>
                  ))}
                </div>
                <div className="progress-bar"><div className="progress-fill" style={{ width: `${Math.min(bs.percent_complete, 100)}%` }} /></div>
                <div className="progress-stats">
                  <span>{formatNumber(bs.raw_ingested || bs.built_pairs)} / {formatNumber(bs.work_queue || bs.total_pairs)}</span>
                  <span>{bs.percent_complete.toFixed(1)}%</span>
                  {bs.status === 'building' && bs.est_remaining_seconds > 0 && <span>~{formatDuration(bs.est_remaining_seconds / 60)} left</span>}
                </div>
                {bs.error && <div className="error-banner">{bs.error}</div>}
              </div>
            );
          })}
        </>
      )}

      <div className="footer-actions">
        <div className="existing-info">
          {Object.keys(existingCounts).length > 0 && (
            <span>Existing: {Object.entries(existingCounts).map(([k, v]) => `${k}: ${formatNumber(v)}`).join(' · ')}</span>
          )}
        </div>
        <button className="btn primary" onClick={startBuild} disabled={isBuilding || selectedRes.size === 0 || !region?.ready}>
          {isBuilding ? 'Building...' : `Build Matrix for ${region?.label || 'Region'}`}
        </button>
      </div>
    </div>
  );
}

import React, { useState, useEffect, useCallback, useRef } from 'react';
import type { MatrixEstimate, MatrixJob, MatrixInventoryItem, RegionInfo } from '../types';
import { RES_LABELS, RES_CUTOFFS, RES_HEX_PER_SQDEG, ROUTING_PROFILES } from '../types';

const RATE_PAIRS_PER_SEC = 31500;
const CREDIT_PER_HOUR_SMALL = 2;
const ALL_RESOLUTIONS = [5, 6, 7, 8, 9, 10];

function estimateHexCount(bounds: RegionInfo['bounds'], res: number): number {
  const area = (bounds.maxLat - bounds.minLat) * (bounds.maxLon - bounds.minLon);
  return Math.round(area * (RES_HEX_PER_SQDEG[res] || 2000));
}

function estimatePairs(hexCount: number): number {
  return hexCount * (hexCount - 1);
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

function formatBytes(bytes: number): string {
  if (bytes >= 1_000_000_000) return (bytes / 1_000_000_000).toFixed(1) + ' GB';
  if (bytes >= 1_000_000) return (bytes / 1_000_000).toFixed(1) + ' MB';
  if (bytes >= 1_000) return (bytes / 1_000).toFixed(1) + ' KB';
  return bytes + ' B';
}

function timeAgo(dateStr: string): string {
  if (!dateStr) return '';
  const d = new Date(dateStr);
  const now = new Date();
  const secs = Math.floor((now.getTime() - d.getTime()) / 1000);
  if (secs < 60) return 'just now';
  if (secs < 3600) return `${Math.floor(secs / 60)}m ago`;
  if (secs < 86400) return `${Math.floor(secs / 3600)}h ago`;
  return `${Math.floor(secs / 86400)}d ago`;
}

const STAGE_STEPS = [
  { key: 'HEXAGONS', label: 'Hexagons', icon: '⬡' },
  { key: 'WORK_QUEUE', label: 'Work Queue', icon: '📋' },
  { key: 'BUILDING', label: 'API Calls', icon: '⟳' },
  { key: 'FLATTENING', label: 'Flatten', icon: '⚡' },
  { key: 'COMPLETE', label: 'Complete', icon: '✓' },
];

function getStageIndex(stage: string): number {
  if (stage === 'NOT_STARTED' || stage === 'STARTING' || stage === 'PENDING') return -1;
  const idx = STAGE_STEPS.findIndex((s) => s.key === stage);
  return idx >= 0 ? idx : -1;
}

export default function MatrixBuilder() {
  const [regions, setRegions] = useState<RegionInfo[]>([]);
  const [loadingRegions, setLoadingRegions] = useState(true);
  const [selectedRegion, setSelectedRegion] = useState<string>('');
  const [selectedProfile, setSelectedProfile] = useState<string>('driving-car');
  const [selectedRes, setSelectedRes] = useState<Set<number>>(new Set([7, 8, 9]));
  const [jobs, setJobs] = useState<MatrixJob[]>([]);
  const [inventory, setInventory] = useState<MatrixInventoryItem[]>([]);
  const [isLaunching, setIsLaunching] = useState(false);
  const [deletingKey, setDeletingKey] = useState<string | null>(null);
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

  const fetchJobs = useCallback(async () => {
    try {
      const r = await fetch('/api/matrix/status');
      const data = await r.json();
      setJobs(data.jobs || []);
    } catch {}
  }, []);

  const fetchInventory = useCallback(async () => {
    try {
      const r = await fetch('/api/matrix/inventory');
      const data = await r.json();
      setInventory(data.inventory || []);
    } catch {}
  }, []);

  useEffect(() => {
    fetchRegions();
    fetchJobs();
    fetchInventory();
    return () => { if (pollRef.current) clearInterval(pollRef.current); };
  }, [fetchRegions, fetchJobs, fetchInventory]);

  useEffect(() => {
    const hasActive = jobs.some((j) => j.status === 'RUNNING' || j.status === 'PENDING');
    if (hasActive && !pollRef.current) {
      pollRef.current = setInterval(() => {
        fetchJobs();
        fetchInventory();
      }, 5000);
    } else if (!hasActive && pollRef.current) {
      clearInterval(pollRef.current);
      pollRef.current = null;
      fetchInventory();
    }
  }, [jobs, fetchJobs, fetchInventory]);

  const region = regions.find((r) => r.region === selectedRegion);

  const hexEstimates = React.useMemo(() => {
    if (!region) return [];
    return ALL_RESOLUTIONS.map((res) => {
      const hexagons = estimateHexCount(region.bounds, res);
      return { res, hexagons, pairs: estimatePairs(hexagons) };
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
    setIsLaunching(true);
    try {
      await fetch('/api/matrix/build', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ region: selectedRegion, resolutions: Array.from(selectedRes).sort(), profile: selectedProfile }),
      });
      await fetchJobs();
    } catch {}
    setIsLaunching(false);
  }, [selectedRegion, selectedRes, selectedProfile, fetchJobs]);

  const cancelJob = useCallback(async (jobId: string) => {
    try {
      await fetch('/api/matrix/cancel', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ job_id: jobId }),
      });
      await fetchJobs();
    } catch {}
  }, [fetchJobs]);

  const deleteConfig = useCallback(async (region: string, profile: string, resolution: string) => {
    const key = `${region}_${profile}_${resolution}`;
    setDeletingKey(key);
    try {
      await fetch(`/api/matrix/${encodeURIComponent(region)}/${encodeURIComponent(profile)}/${encodeURIComponent(resolution)}`, { method: 'DELETE' });
      await fetchInventory();
      await fetchJobs();
    } catch {}
    setDeletingKey(null);
  }, [fetchInventory, fetchJobs]);

  const readyRegions = regions.filter((r) => r.ready);
  const activeJobs = jobs.filter((j) => j.status === 'RUNNING' || j.status === 'PENDING');
  const recentJobs = jobs.filter((j) => j.status === 'ERROR').slice(0, 5);

  return (
    <div className="panel">
      <h2>Travel Time Matrix Builder</h2>
      <p className="subtitle">Pre-compute driving times between H3 hexagons using OpenRouteService</p>

      {inventory.length > 0 && (
        <>
          <h3>Matrix Inventory</h3>
          <table className="services-table">
            <thead>
              <tr><th>Region</th><th>Profile</th><th>Resolution</th><th>Pairs</th><th>Size</th><th>Build Time</th><th>Created</th><th></th></tr>
            </thead>
            <tbody>
              {inventory.map((item) => {
                const key = `${item.region}_${item.profile}_${item.resolution}`;
                return (
                  <tr key={key}>
                    <td>{item.region}</td>
                    <td>{item.profile}</td>
                    <td>{item.resolution} — {RES_LABELS[parseInt(item.resolution.replace('RES', ''))] || ''}</td>
                    <td>{formatNumber(item.row_count)}</td>
                    <td>{formatBytes(item.bytes)}</td>
                    <td>{item.execution_time_secs > 0 ? formatDuration(item.execution_time_secs / 60) : '—'}</td>
                    <td>{timeAgo(item.created)}</td>
                    <td>
                      <button
                        className="btn small danger"
                        disabled={deletingKey === key}
                        onClick={() => deleteConfig(item.region, item.profile, item.resolution)}
                      >
                        {deletingKey === key ? '...' : 'Delete'}
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </>
      )}

      {activeJobs.length > 0 && (
        <>
          <h3>Active Builds</h3>
          {activeJobs.map((job) => {
            const stageIdx = getStageIndex(job.stage);
            const resNum = parseInt(job.resolution.replace('RES', ''));
            const pct = job.stage === 'BUILDING' && job.work_queue_rows > 0
              ? Math.round(job.raw_rows * 1000 / job.work_queue_rows) / 10
              : job.pct_complete;
            return (
              <div key={job.job_id} className="progress-card">
                <div className="progress-header">
                  <span>{job.region} / {job.profile} / {job.resolution} — {RES_LABELS[resNum] || ''}</span>
                  <span className="badge warn">{job.stage}</span>
                </div>
                <div className="stage-pipeline">
                  {STAGE_STEPS.map((step, i) => (
                    <div key={step.key} className={`stage-step ${i === stageIdx ? 'active' : ''} ${i < stageIdx ? 'done' : ''}`}>
                      <span>{i < stageIdx ? '✓' : step.icon}</span>
                      <span>{step.label}</span>
                    </div>
                  ))}
                </div>
                <div className="progress-bar"><div className="progress-fill" style={{ width: `${Math.min(pct, 100)}%` }} /></div>
                <div className="progress-stats">
                  {job.stage === 'BUILDING' && <span>{formatNumber(job.raw_rows)} / {formatNumber(job.work_queue_rows)} origins</span>}
                  {job.stage === 'HEXAGONS' && <span>{formatNumber(job.hexagons)} hexagons</span>}
                  <span>{pct.toFixed(1)}%</span>
                  <span>Started {timeAgo(job.started_at || job.created_at)}</span>
                  <button className="btn small danger" onClick={() => cancelJob(job.job_id)}>Cancel</button>
                </div>
              </div>
            );
          })}
        </>
      )}

      {recentJobs.length > 0 && (
        <>
          <h3>Recent Errors</h3>
          {recentJobs.map((job) => (
            <div key={job.job_id} className="error-banner">
              <strong>{job.region}/{job.profile}/{job.resolution}</strong>: {job.error_msg}
              <span style={{ opacity: 0.6, marginLeft: 8 }}>{timeAgo(job.completed_at)}</span>
            </div>
          ))}
        </>
      )}

      <h3>{inventory.length > 0 || activeJobs.length > 0 ? 'New Build' : '1. Select Region'}</h3>
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
          <h3>Routing Profile</h3>
          <div className="region-grid">
            {ROUTING_PROFILES.map((p) => (
              <button
                key={p}
                className={`region-card ${selectedProfile === p ? 'active' : ''}`}
                onClick={() => setSelectedProfile(p)}
              >
                <div className="region-name">{p}</div>
              </button>
            ))}
          </div>

          <h3>Select Resolutions</h3>
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

          <h3>Resource Estimate</h3>
          <div className="estimate-grid">
            <div className="estimate-card primary"><div className="estimate-label">Total Pairs</div><div className="estimate-value">~{formatNumber(estimate.total_pairs)}</div></div>
            <div className="estimate-card"><div className="estimate-label">Est. Time</div><div className="estimate-value">{formatDuration(estimate.total_time_minutes)}</div></div>
            <div className="estimate-card"><div className="estimate-label">Credits</div><div className="estimate-value">{estimate.total_credits.toFixed(1)}</div></div>
            <div className="estimate-card highlight"><div className="estimate-label">Est. Cost</div><div className="estimate-value">{formatCost(estimate.snowflake_cost)}</div></div>
          </div>

          <h3>Cost Comparison</h3>
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

      <div className="footer-actions">
        <div className="existing-info">
          {activeJobs.length > 0 && <span>{activeJobs.length} build{activeJobs.length > 1 ? 's' : ''} in progress</span>}
        </div>
        <button className="btn primary" onClick={startBuild} disabled={isLaunching || selectedRes.size === 0 || !region?.ready}>
          {isLaunching ? 'Launching...' : `Build Matrix for ${region?.label || 'Region'}`}
        </button>
      </div>
    </div>
  );
}

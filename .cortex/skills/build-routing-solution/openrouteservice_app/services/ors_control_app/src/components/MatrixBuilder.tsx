import React, { useState, useEffect, useCallback, useRef } from 'react';
import type { MatrixJob, MatrixInventoryItem, RegionInfo } from '../types';
import { RES_LABELS, RES_CUTOFFS, RES_HEX_PER_SQDEG, ROUTING_PROFILES } from '../types';
import { safeFetchJson } from '../utils/safeFetch';

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

function RoadFilterBadge({ on }: { on: boolean | undefined }) {
  if (!on) return null;
  return (
    <span
      title="Built with Road-Aware Filtering: only hexagons intersecting road segments were tessellated"
      style={{
        display: 'inline-block',
        marginLeft: 6,
        padding: '1px 6px',
        fontSize: 10,
        fontWeight: 600,
        letterSpacing: 0.3,
        textTransform: 'uppercase',
        color: '#3fb950',
        background: 'rgba(63, 185, 80, 0.12)',
        border: '1px solid rgba(63, 185, 80, 0.4)',
        borderRadius: 4,
        verticalAlign: 'middle',
      }}
    >
      road-aware
    </span>
  );
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
  const [buildError, setBuildError] = useState<string | null>(null);
  const [deletingKey, setDeletingKey] = useState<string | null>(null);
  const [dismissedErrors, setDismissedErrors] = useState<Set<string>>(new Set());
  const [roadFilterEnabled, setRoadFilterEnabled] = useState(true);
  const [roadFilterAvailable, setRoadFilterAvailable] = useState<boolean | null>(null);
  const [roadFilterReason, setRoadFilterReason] = useState<string>('');
  const [serverHexEstimate, setServerHexEstimate] = useState<Record<number, number>>({});
  const [estimateLoading, setEstimateLoading] = useState(false);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const fetchRegions = useCallback(async () => {
    setLoadingRegions(true);
    const { ok, data } = await safeFetchJson<{ regions: RegionInfo[] }>('/api/matrix/regions');
    if (ok && data) {
      const fetched = data.regions || [];
      setRegions(fetched);
      if (fetched.length > 0 && !selectedRegion) {
        const sf = fetched.find((r) => r.region.toUpperCase() === 'SANFRANCISCO');
        const running = fetched.find((r) => r.serviceStatus === 'RUNNING');
        setSelectedRegion((sf || running || fetched[0]).region);
      }
    }
    setLoadingRegions(false);
  }, []);

  const fetchJobs = useCallback(async () => {
    const { ok, data } = await safeFetchJson<{ jobs: MatrixJob[] }>('/api/matrix/status');
    if (ok && data) setJobs(data.jobs || []);
  }, []);

  const fetchInventory = useCallback(async () => {
    const { ok, data } = await safeFetchJson<{ inventory: MatrixInventoryItem[] }>('/api/matrix/inventory');
    if (ok && data) setInventory(data.inventory || []);
  }, []);

  useEffect(() => {
    fetchRegions();
    fetchJobs();
    fetchInventory();
    safeFetchJson<{ available: boolean; reason?: string }>('/api/matrix/road-filter-available').then(({ ok, data }) => {
      if (ok && data) {
        setRoadFilterAvailable(!!data.available);
        if (!data.available) {
          setRoadFilterReason(data.reason || 'Overture Transportation not accessible');
          setRoadFilterEnabled(false);
        }
      } else {
        setRoadFilterAvailable(false);
        setRoadFilterEnabled(false);
      }
    });
    return () => { if (pollRef.current) clearInterval(pollRef.current); };
  }, [fetchRegions, fetchJobs, fetchInventory]);

  useEffect(() => {
    if (!roadFilterEnabled || !roadFilterAvailable || !selectedRegion || selectedRes.size === 0) {
      setServerHexEstimate({});
      return;
    }
    let cancelled = false;
    const timer = setTimeout(async () => {
      setEstimateLoading(true);
      const { ok, data, error } = await safeFetchJson<{ resolutions: any[] }>('/api/matrix/cost-estimate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          region: selectedRegion,
          profile: selectedProfile,
          resolutions: Array.from(selectedRes).sort(),
          road_filter: true,
        }),
      });
      if (cancelled) return;
      if (ok && data) {
        const map: Record<number, number> = {};
        (data.resolutions || []).forEach((e: any) => {
          if (e.road_filter_applied) {
            map[parseInt(e.resolution.replace('RES', ''))] = e.hex_count;
          }
        });
        setServerHexEstimate(map);
      } else {
        setServerHexEstimate({});
        if (error?.includes('504') || error?.includes('timed out')) {
          setBuildError('Road-aware estimate timed out. Try disabling Road-aware filter or selecting fewer resolutions.');
        }
      }
      setEstimateLoading(false);
    }, 500);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [roadFilterEnabled, roadFilterAvailable, selectedRegion, selectedProfile, selectedRes]);

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
      const bboxHexagons = estimateHexCount(region.bounds, res);
      const hexagons = serverHexEstimate[res] ?? bboxHexagons;
      return { res, hexagons, bboxHexagons, pairs: estimatePairs(hexagons), filtered: serverHexEstimate[res] !== undefined };
    });
  }, [region, serverHexEstimate]);

  const estimate = React.useMemo(() => {
    const resolutions = hexEstimates.filter((h) => selectedRes.has(h.res)).map((h) => {
      const timeMin = h.pairs / RATE_PAIRS_PER_SEC / 60;
      return { res: h.res, label: RES_LABELS[h.res], hexagons: h.hexagons, cutoff_miles: RES_CUTOFFS[h.res], sparse_pairs: h.pairs, est_time_minutes: timeMin, est_credits: (timeMin / 60) * CREDIT_PER_HOUR_SMALL };
    });
    const totalTime = resolutions.reduce((s, r) => s + r.est_time_minutes, 0);
    const totalPairs = resolutions.reduce((s, r) => s + r.sparse_pairs, 0);
    return {
      region: region?.label || '', resolutions, total_pairs: totalPairs, total_time_minutes: totalTime,
      total_credits: (totalTime / 60) * CREDIT_PER_HOUR_SMALL,
    };
  }, [hexEstimates, selectedRes, region]);

  const toggleRes = (res: number) => setSelectedRes((prev) => { const next = new Set(prev); if (next.has(res)) next.delete(res); else next.add(res); return next; });

  const startBuild = useCallback(async () => {
    if (!selectedRegion) return;
    setIsLaunching(true);
    setBuildError(null);
    const { ok, data, error } = await safeFetchJson<{ status: string; error?: string; warning?: string }>('/api/matrix/build', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        region: selectedRegion,
        resolutions: Array.from(selectedRes).sort(),
        profile: selectedProfile,
        road_filter: roadFilterEnabled && roadFilterAvailable === true,
      }),
    });
    if (ok && data) {
      if (data.error) setBuildError(data.error);
      else if (data.warning) setBuildError(data.warning);
    } else {
      setBuildError(error || 'Failed to launch build');
    }
    await fetchJobs();
    setIsLaunching(false);
  }, [selectedRegion, selectedRes, selectedProfile, roadFilterEnabled, roadFilterAvailable, fetchJobs]);

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
  const failedJobs = jobs.filter((j) => j.status === 'ERROR' && !dismissedErrors.has(j.job_id)).slice(0, 10);

  const retryMatrixBuild = useCallback(async (job: MatrixJob) => {
    const resNum = parseInt(job.resolution.replace('RES', ''));
    setSelectedRegion(job.region);
    setSelectedProfile(job.profile);
    setSelectedRes(new Set([resNum]));
    setDismissedErrors(prev => new Set(prev).add(job.job_id));
  }, []);

  const dismissError = useCallback((jobId: string) => {
    setDismissedErrors(prev => new Set(prev).add(jobId));
  }, []);

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
                    <td>{item.resolution} — {RES_LABELS[parseInt(item.resolution.replace('RES', ''))] || ''}<RoadFilterBadge on={item.road_filter} /></td>
                    <td>{formatNumber(item.row_count)}</td>
                    <td>{formatBytes(item.bytes)}</td>
                    <td>{item.execution_time_secs > 0 ? formatDuration(item.execution_time_secs / 60) : '—'}</td>
                    <td>{timeAgo(item.created)}</td>
                    <td>
                      <button
                        className="btn small danger"
                        disabled={deletingKey === key}
                        onClick={() => deleteConfig(item.table_region, item.profile, item.resolution)}
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
            const isQueued = stageIdx < 0;
            const pct = isQueued ? 0
              : job.stage === 'BUILDING' && job.work_queue_rows > 0
              ? Math.round(job.raw_rows * 1000 / job.work_queue_rows) / 10
              : job.pct_complete;
            return (
              <div key={job.job_id} className="progress-card">
                <div className="progress-header">
                  <span>{job.region} / {job.profile} / {job.resolution} — {RES_LABELS[resNum] || ''}<RoadFilterBadge on={job.road_filter} /></span>
                  <span className={`badge ${isQueued ? '' : 'warn'}`}>{isQueued ? 'Queued' : job.stage}</span>
                </div>
                {isQueued ? (
                  <div style={{ fontSize: 12, color: 'var(--text-secondary)', padding: '8px 0' }}>Waiting to start...</div>
                ) : (
                  <>
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
                      {job.stage === 'BUILDING' && <span>{formatNumber(job.raw_rows)} / {formatNumber(job.work_queue_rows)} chunks ({formatNumber(job.hexagons)} origins)</span>}
                      {job.stage === 'HEXAGONS' && <span>{formatNumber(job.hexagons)} hexagons</span>}
                      {job.stage === 'WORK_QUEUE' && <span>Creating work queue...</span>}
                      {job.stage === 'FLATTENING' && <span>Flattening raw results...</span>}
                      <span>{pct.toFixed(1)}%</span>
                      <span>Started {timeAgo(job.started_at || job.created_at)}</span>
                      <button className="btn small danger" onClick={() => cancelJob(job.job_id)}>Cancel</button>
                    </div>
                  </>
                )}
              </div>
            );
          })}
        </>
      )}

      {failedJobs.length > 0 && (
        <>
          <h3>Failed Builds</h3>
          {failedJobs.map((job) => {
            const resNum = parseInt(job.resolution.replace('RES', ''));
            return (
              <div key={job.job_id} style={{ margin: '8px 0', padding: '12px 16px', background: 'rgba(229, 57, 53, 0.12)', borderRadius: 8, border: '1px solid rgba(229, 57, 53, 0.4)' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
                  <div>
                    <strong>{job.region} / {job.profile} / {job.resolution} — {RES_LABELS[resNum] || ''}<RoadFilterBadge on={job.road_filter} /></strong>
                    <span className="badge error" style={{ marginLeft: 8 }}>FAILED</span>
                    {job.stage && <span style={{ fontSize: 11, color: 'var(--text-secondary)', marginLeft: 8 }}>at stage: {job.stage}</span>}
                    {job.completed_at && <span style={{ fontSize: 11, color: 'var(--text-secondary)', marginLeft: 8 }}>{timeAgo(job.completed_at)}</span>}
                  </div>
                  <div style={{ display: 'flex', gap: '0.5rem' }}>
                    <button className="btn small primary" onClick={() => retryMatrixBuild(job)}>Retry</button>
                    <button className="btn small" onClick={() => dismissError(job.job_id)}>Dismiss</button>
                  </div>
                </div>
                <div style={{ fontSize: 12, color: '#e53935', whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
                  {job.error_msg || 'Unknown error'}
                </div>
              </div>
            );
          })}
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

          <h3>Road-Aware Filtering</h3>
          <label
            className={`res-card ${roadFilterEnabled && roadFilterAvailable ? 'active' : ''}`}
            style={{ cursor: roadFilterAvailable === false ? 'not-allowed' : 'pointer', opacity: roadFilterAvailable === false ? 0.6 : 1 }}
            title={roadFilterAvailable === false ? roadFilterReason : 'Skips hexagons with no road coverage. Reduces credits and build time.'}
          >
            <input
              type="checkbox"
              checked={roadFilterEnabled && roadFilterAvailable === true}
              disabled={roadFilterAvailable !== true}
              onChange={(e) => setRoadFilterEnabled(e.target.checked)}
            />
            <div>
              <div className="res-label">
                Road-Aware Filtering {estimateLoading ? ' (recalculating...)' : ''}
              </div>
              <div className="res-detail">
                {roadFilterAvailable === null && 'Checking Overture Maps Transportation availability...'}
                {roadFilterAvailable === false && `Unavailable: ${roadFilterReason}`}
                {roadFilterAvailable === true && roadFilterEnabled && 'Only hexagons intersecting roads will be tessellated (default ON)'}
                {roadFilterAvailable === true && !roadFilterEnabled && 'Disabled — full bbox tessellation (legacy behaviour)'}
              </div>
            </div>
          </label>

          <h3>Select Resolutions</h3>
          <div className="res-grid">
            {hexEstimates.map((h) => (
              <label key={h.res} className={`res-card ${selectedRes.has(h.res) ? 'active' : ''}`}>
                <input type="checkbox" checked={selectedRes.has(h.res)} onChange={() => toggleRes(h.res)} />
                <div>
                  <div className="res-label">Res {h.res} — {RES_LABELS[h.res]}<RoadFilterBadge on={roadFilterEnabled && roadFilterAvailable === true} /></div>
                  <div className="res-detail">
                    ~{formatNumber(h.hexagons)} hexagons
                    {h.filtered && h.bboxHexagons > 0 && (
                      <span style={{ color: 'var(--accent, #3fb950)', marginLeft: 6 }}>
                        (-{Math.round((1 - h.hexagons / h.bboxHexagons) * 100)}% vs bbox)
                      </span>
                    )}
                    {' '}· {RES_CUTOFFS[h.res]}mi cutoff · ~{formatNumber(h.pairs)} pairs
                  </div>
                </div>
              </label>
            ))}
          </div>

          <h3>Resource Estimate</h3>
          <div className="estimate-grid">
            <div className="estimate-card primary"><div className="estimate-label">Total Pairs</div><div className="estimate-value">~{formatNumber(estimate.total_pairs)}</div></div>
            <div className="estimate-card"><div className="estimate-label">Est. Time</div><div className="estimate-value">{formatDuration(estimate.total_time_minutes)}</div></div>
            <div className="estimate-card"><div className="estimate-label">Credits</div><div className="estimate-value">{estimate.total_credits.toFixed(1)}</div></div>
          </div>
        </>
      )}

      <div className="footer-actions">
        <div className="existing-info">
          {activeJobs.length > 0 && <span>{activeJobs.length} build{activeJobs.length > 1 ? 's' : ''} in progress</span>}
        </div>
        <button className="btn primary" onClick={startBuild} disabled={isLaunching || estimateLoading || selectedRes.size === 0 || !region?.ready}>
          {isLaunching ? 'Launching...' : estimateLoading ? 'Estimating...' : `Build Matrix for ${region?.label || 'Region'}`}
        </button>
      </div>
      {buildError && (
        <div className="error-banner" style={{ marginTop: 8 }}>
          <strong>Build failed:</strong> {buildError}
        </div>
      )}
    </div>
  );
}

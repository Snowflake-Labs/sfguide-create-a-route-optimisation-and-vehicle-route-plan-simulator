import React, { useState, useEffect, useCallback, useRef } from 'react';
import type { MatrixJob, MatrixInventoryItem, RegionInfo } from '../types';
import { RES_LABELS, RES_CUTOFFS, RES_HEX_PER_SQDEG, ROUTING_PROFILES } from '../types';
import { safeFetchJson } from '../utils/safeFetch';

const RATE_PAIRS_PER_SEC = 31500;
const CREDIT_PER_HOUR_SMALL = 2;
const ALL_RESOLUTIONS = [5, 6, 7, 8, 9, 10];

// Issue #39: cost-gating thresholds
const CREDITS_GREEN_MAX = 5;
const CREDITS_YELLOW_MAX = 25;
const PAIR_CAP = 100_000_000;

interface CostEstimateVariant {
  cells: number;
  matrix_rows: number;
  warehouse_credits: number;
  spcs_credits: number;
  total_credits: number;
  duration_seconds: number;
  confidence: 'high' | 'medium' | 'low';
  sample_size: number;
}
interface CostEstimatePayload {
  region: string;
  profile: string;
  h3_resolution: number;
  bucket: string;
  area_km2: number;
  generated_at: string;
  estimates: {
    road_filter_off: CostEstimateVariant;
    road_filter_on: CostEstimateVariant;
  };
}

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
  if (Number.isNaN(d.getTime())) return '\u2014';
  const now = new Date();
  const secs = Math.floor((now.getTime() - d.getTime()) / 1000);
  if (secs < 0) return '\u2014';
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

function creditBand(credits: number): 'green' | 'yellow' | 'red' {
  if (credits <= CREDITS_GREEN_MAX) return 'green';
  if (credits <= CREDITS_YELLOW_MAX) return 'yellow';
  return 'red';
}

function CostEstimateCard({ variant, label }: { variant: CostEstimateVariant | undefined; label: string }) {
  if (!variant || variant.cells == null) {
    return (
      <div className="estimate-mini" style={{ padding: 12, border: '1px solid var(--border, #333)', borderRadius: 8, opacity: 0.6 }}>
        <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 6 }}>{label}</div>
        <div style={{ fontSize: 11 }}>No data</div>
      </div>
    );
  }
  const band = creditBand(variant.total_credits || 0);
  const bandColor = band === 'green' ? '#3fb950' : band === 'yellow' ? '#d29922' : '#e53935';
  const minutes = Math.round((variant.duration_seconds || 0) / 6) / 10;
  return (
    <div className="estimate-mini" style={{ padding: 12, border: `1px solid ${bandColor}55`, background: `${bandColor}14`, borderRadius: 8 }}>
      <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 6 }}>
        {label} <span style={{ float: 'right', fontSize: 10, textTransform: 'uppercase', color: bandColor }}>{band}</span>
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', rowGap: 4, fontSize: 12 }}>
        <span>Cells</span><span style={{ textAlign: 'right' }}>{formatNumber(variant.cells)}</span>
        <span>Matrix rows</span><span style={{ textAlign: 'right' }}>{formatNumber(variant.matrix_rows)}</span>
        <span>WH credits</span><span style={{ textAlign: 'right' }}>{(variant.warehouse_credits || 0).toFixed(2)}</span>
        <span>SPCS credits</span><span style={{ textAlign: 'right' }}>{(variant.spcs_credits || 0).toFixed(2)}</span>
        <span style={{ fontWeight: 600 }}>Total credits</span>
        <span style={{ textAlign: 'right', fontWeight: 600, color: bandColor }}>{(variant.total_credits || 0).toFixed(2)}</span>
        <span>Duration</span><span style={{ textAlign: 'right' }}>{minutes < 1 ? `${variant.duration_seconds}s` : formatDuration(minutes)}</span>
        <span>Confidence</span><span style={{ textAlign: 'right' }}>{variant.confidence} ({variant.sample_size})</span>
      </div>
    </div>
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
  const [costEstimates, setCostEstimates] = useState<Record<number, CostEstimatePayload>>({});
  const [costEstimateLoading, setCostEstimateLoading] = useState(false);
  const [costEstimateError, setCostEstimateError] = useState<string | null>(null);
  const [acknowledgeHighCost, setAcknowledgeHighCost] = useState(false);
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

  // Issue #39: aggregate calibration-backed estimate across selected resolutions, using selected road_filter variant
  const { totalEstimatedCredits, totalEstimatedPairs } = React.useMemo(() => {
    const useFilter = roadFilterEnabled && roadFilterAvailable === true;
    let credits = 0;
    let pairs = 0;
    Array.from(selectedRes).forEach((res) => {
      const payload = costEstimates[res];
      if (!payload) return;
      const v = useFilter ? payload.estimates?.road_filter_on : payload.estimates?.road_filter_off;
      if (v) {
        credits += v.total_credits || 0;
        pairs += v.matrix_rows || 0;
      }
    });
    return { totalEstimatedCredits: credits, totalEstimatedPairs: pairs };
  }, [costEstimates, selectedRes, roadFilterEnabled, roadFilterAvailable]);

  const requiresAcknowledgement = totalEstimatedCredits > CREDITS_YELLOW_MAX || totalEstimatedPairs > PAIR_CAP;

  const toggleRes = (res: number) => setSelectedRes((prev) => { const next = new Set(prev); if (next.has(res)) next.delete(res); else next.add(res); return next; });

  const fetchCostEstimates = useCallback(async () => {
    if (!selectedRegion || selectedRes.size === 0) return;
    setCostEstimateLoading(true);
    setCostEstimateError(null);
    setAcknowledgeHighCost(false);
    const next: Record<number, CostEstimatePayload> = {};
    try {
      await Promise.all(Array.from(selectedRes).map(async (res) => {
        const { ok, data, error } = await safeFetchJson<{ payload: CostEstimatePayload }>('/api/matrix/estimate', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            region: selectedRegion,
            resolution: res,
            profile: selectedProfile,
            road_filter: null,
          }),
        });
        if (ok && data?.payload) next[res] = data.payload;
        else if (error) setCostEstimateError(error);
      }));
      setCostEstimates(next);
    } finally {
      setCostEstimateLoading(false);
    }
  }, [selectedRegion, selectedRes, selectedProfile]);

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

          {/* Issue #39: calibration-backed cost estimator with road_filter ON/OFF comparison */}
          <div style={{ marginTop: 16, padding: 12, border: '1px solid var(--border, #333)', borderRadius: 8 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
              <strong>Calibrated Cost Estimate</strong>
              <button className="btn small" onClick={fetchCostEstimates} disabled={costEstimateLoading || selectedRes.size === 0}>
                {costEstimateLoading ? 'Estimating...' : 'Estimate cost'}
              </button>
            </div>
            {costEstimateError && (
              <div style={{ fontSize: 12, color: '#e53935', marginBottom: 8 }}>{costEstimateError}</div>
            )}
            {Object.keys(costEstimates).length === 0 && !costEstimateLoading && (
              <div style={{ fontSize: 12, color: 'var(--text-secondary)' }}>
                Click "Estimate cost" to see calibration-backed predictions for road-filter ON vs OFF.
              </div>
            )}
            {Object.entries(costEstimates).sort(([a], [b]) => parseInt(a) - parseInt(b)).map(([resKey, payload]) => (
              <div key={resKey} style={{ marginTop: 8 }}>
                <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 6 }}>
                  Res {resKey} — {payload.area_km2} km^2 · {payload.bucket}
                </div>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
                  <CostEstimateCard variant={payload.estimates?.road_filter_off} label="Road filter OFF" />
                  <CostEstimateCard variant={payload.estimates?.road_filter_on}  label="Road filter ON" />
                </div>
              </div>
            ))}
            {totalEstimatedCredits > 0 && (
              <div style={{ marginTop: 12, padding: 8, background: 'var(--surface, #1a1a1a)', borderRadius: 6, fontSize: 12 }}>
                Total estimated credits across selected resolutions:{' '}
                <strong style={{ color: creditBand(totalEstimatedCredits) === 'green' ? '#3fb950' : creditBand(totalEstimatedCredits) === 'yellow' ? '#d29922' : '#e53935' }}>
                  {totalEstimatedCredits.toFixed(2)}
                </strong>
                {' · '}Total pairs: {formatNumber(totalEstimatedPairs)}
              </div>
            )}
            {requiresAcknowledgement && (
              <label style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 10, fontSize: 12, color: '#d29922' }}>
                <input type="checkbox" checked={acknowledgeHighCost} onChange={(e) => setAcknowledgeHighCost(e.target.checked)} />
                I understand this build is expected to consume {totalEstimatedCredits.toFixed(1)} credits ({formatNumber(totalEstimatedPairs)} pairs)
              </label>
            )}
          </div>
        </>
      )}

      <div className="footer-actions">
        <div className="existing-info">
          {activeJobs.length > 0 && <span>{activeJobs.length} build{activeJobs.length > 1 ? 's' : ''} in progress</span>}
        </div>
        <button
          className="btn primary"
          onClick={startBuild}
          disabled={
            isLaunching ||
            estimateLoading ||
            selectedRes.size === 0 ||
            !region?.ready ||
            (requiresAcknowledgement && !acknowledgeHighCost)
          }
          title={requiresAcknowledgement && !acknowledgeHighCost ? 'High-cost build: tick the acknowledgement above to proceed' : ''}
        >
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

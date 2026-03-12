import React, { useState, useEffect, useCallback, useRef } from 'react';
import type { MatrixEstimate, MatrixBuildStatus } from '../types';

interface Props {
  open: boolean;
  onClose: () => void;
}

interface RegionInfo {
  region: string;
  label: string;
  bounds: { minLat: number; maxLat: number; minLon: number; maxLon: number };
  serviceStatus: string;
  serviceExists: boolean;
  matrixFunctionExists: boolean;
  directionsFunctionExists: boolean;
  ready: boolean;
  provisioned: boolean;
  matrixFn: string;
  cities: string[];
}

const RES_LABELS: Record<number, string> = {
  9: 'Last Mile (174m)',
  8: 'Delivery Zone (460m)',
  7: 'Long Range (1.2km)',
};

const RES_CUTOFFS: Record<number, number> = { 9: 2, 8: 10, 7: 50 };

const RATE_PAIRS_PER_SEC = 31500;
const CREDIT_PER_HOUR_SMALL = 2;

function estimateHexCount(bounds: RegionInfo['bounds'], res: number): number {
  const latRange = bounds.maxLat - bounds.minLat;
  const lonRange = bounds.maxLon - bounds.minLon;
  const area = latRange * lonRange;
  if (res === 9) return Math.round(area * 90000);
  if (res === 8) return Math.round(area * 13500);
  return Math.round(area * 2000);
}

function estimatePairs(hexCount: number, res: number): number {
  const kRing = res === 7 ? 33 : res === 8 ? 17 : 9;
  const avgNeighbors = Math.min(hexCount - 1, kRing * 6);
  return hexCount * avgNeighbors;
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

type ModalView = 'main' | 'confirm-remove' | 'removing' | 'removed' | 'confirm-restore' | 'restoring' | 'restored';

interface RemoveResult {
  table: string;
  rows_before: number;
  status: string;
}

interface RestoreResult {
  table: string;
  rows_restored: number;
  status: string;
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

export default function MatrixBuilder({ open, onClose }: Props) {
  const [regions, setRegions] = useState<RegionInfo[]>([]);
  const [loadingRegions, setLoadingRegions] = useState(false);
  const [selectedRegion, setSelectedRegion] = useState<string>('');
  const [selectedRes, setSelectedRes] = useState<Set<number>>(new Set([9, 8, 7]));
  const [buildStatus, setBuildStatus] = useState<MatrixBuildStatus[]>([]);
  const [isBuilding, setIsBuilding] = useState(false);
  const [liveProgress, setLiveProgress] = useState<Record<string, { built: number; total: number }>>({});
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const [existingCounts, setExistingCounts] = useState<Record<string, number>>({});
  const [loadingExisting, setLoadingExisting] = useState(false);
  const [modalView, setModalView] = useState<ModalView>('main');
  const [removeResults, setRemoveResults] = useState<Record<string, RemoveResult>>({});
  const [restoreResults, setRestoreResults] = useState<Record<string, RestoreResult>>({});
  const [restoreMinutes, setRestoreMinutes] = useState(5);

  const fetchRegions = useCallback(async () => {
    setLoadingRegions(true);
    try {
      const r = await fetch('/api/matrix/regions');
      const data = await r.json();
      const fetched: RegionInfo[] = data.regions || [];
      setRegions(fetched);
      const readyOnes = fetched.filter((r) => r.ready);
      if (readyOnes.length > 0 && !selectedRegion) {
        const running = readyOnes.find((r) => r.serviceStatus === 'RUNNING');
        setSelectedRegion((running || readyOnes[0]).region);
      } else if (fetched.length > 0 && !selectedRegion) {
        setSelectedRegion(fetched[0].region);
      }
    } catch {}
    setLoadingRegions(false);
  }, []);

  const refreshExisting = useCallback(() => {
    setLoadingExisting(true);
    const params = selectedRegion ? `?region=${selectedRegion}` : '';
    fetch(`/api/matrix/existing${params}`)
      .then((r) => r.json())
      .then((data) => {
        setExistingCounts(data);
        setLoadingExisting(false);
      })
      .catch(() => setLoadingExisting(false));
  }, [selectedRegion]);

  useEffect(() => {
    if (!open) return;
    setModalView('main');
    fetchRegions();
    return () => {
      if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; }
    };
  }, [open, fetchRegions]);

  useEffect(() => {
    if (!open || !selectedRegion) return;
    refreshExisting();
  }, [open, selectedRegion, refreshExisting]);

  const hasExistingData = Object.values(existingCounts).some((v) => (v as number) > 0);
  const totalExisting = Object.values(existingCounts).reduce((s, v) => s + (v as number), 0);

  const executeRemove = useCallback(async () => {
    setModalView('removing');
    try {
      const regionParam = selectedRegion ? `&region=${selectedRegion}` : '';
      const resp = await fetch(`/api/matrix/remove?resolutions=7,8,9${regionParam}`, { method: 'DELETE' });
      const data = await resp.json();
      setRemoveResults(data.resolutions || {});
      setModalView('removed');
      refreshExisting();
    } catch (err: any) {
      setRemoveResults({ error: { table: 'error', rows_before: 0, status: 'error' } });
      setModalView('removed');
    }
  }, [selectedRegion, refreshExisting]);

  const executeRestore = useCallback(async () => {
    setModalView('restoring');
    try {
      const resp = await fetch('/api/matrix/restore', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ resolutions: [7, 8, 9], offset_minutes: restoreMinutes, region: selectedRegion || '' }),
      });
      const data = await resp.json();
      setRestoreResults(data.resolutions || {});
      setModalView('restored');
      refreshExisting();
    } catch (err: any) {
      setRestoreResults({ error: { table: 'error', rows_restored: 0, status: 'error' } });
      setModalView('restored');
    }
  }, [selectedRegion, restoreMinutes, refreshExisting]);

  const region = regions.find((r) => r.region === selectedRegion);
  const regionReady = region?.ready ?? false;

  const hexEstimates = React.useMemo(() => {
    if (!region) return [];
    return [9, 8, 7].map((res) => {
      const hexagons = estimateHexCount(region.bounds, res);
      const pairs = estimatePairs(hexagons, res);
      return { res, hexagons, pairs };
    });
  }, [region]);

  const estimate = React.useMemo(() => {
    const resolutions = hexEstimates
      .filter((h) => selectedRes.has(h.res))
      .map((h) => {
        const timeMin = h.pairs / RATE_PAIRS_PER_SEC / 60;
        const credits = (timeMin / 60) * CREDIT_PER_HOUR_SMALL;
        return {
          res: h.res,
          label: RES_LABELS[h.res],
          hexagons: h.hexagons,
          cutoff_miles: RES_CUTOFFS[h.res],
          sparse_pairs: h.pairs,
          est_time_minutes: timeMin,
          est_credits: credits,
        };
      });

    const totalPairs = resolutions.reduce((s, r) => s + r.sparse_pairs, 0);
    const totalTime = resolutions.reduce((s, r) => s + r.est_time_minutes, 0);
    const totalCredits = (totalTime / 60) * CREDIT_PER_HOUR_SMALL;

    const apiComparisons = [
      { provider: 'Google Distance Matrix API', cost_per_call: 0.005, calls_needed: totalPairs, total_cost: totalPairs * 0.005 },
      { provider: 'HERE Matrix Routing', cost_per_call: 0.0035, calls_needed: totalPairs, total_cost: totalPairs * 0.0035 },
      { provider: 'Mapbox Matrix API', cost_per_call: 0.0004, calls_needed: totalPairs, total_cost: totalPairs * 0.0004 },
    ];

    return {
      region: region?.label || '',
      resolutions,
      total_pairs: totalPairs,
      total_time_minutes: totalTime,
      total_credits: totalCredits,
      snowflake_cost: totalCredits * 2.5,
      api_comparison: apiComparisons,
    } as MatrixEstimate;
  }, [hexEstimates, selectedRes, region]);

  const toggleRes = (res: number) => {
    setSelectedRes((prev) => {
      const next = new Set(prev);
      if (next.has(res)) next.delete(res);
      else next.add(res);
      return next;
    });
  };

  const startBuild = useCallback(async () => {
    if (!selectedRegion) return;
    setIsBuilding(true);
    setBuildStatus([]);
    setLiveProgress({});

    try {
      const res = await fetch('/api/matrix/build', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          region: selectedRegion,
          resolutions: Array.from(selectedRes).sort(),
        }),
      });
      const data = await res.json();
      if (data.status === 'started') {
        pollRef.current = setInterval(async () => {
          try {
            const statusRes = await fetch(`/api/matrix/status?region=${selectedRegion}`);
            const statusData = await statusRes.json();
            setBuildStatus(statusData.resolutions || []);
            const prog: Record<string, { built: number; total: number }> = {};
            for (const r of statusData.resolutions || []) {
              prog[`res${r.resolution}`] = { built: r.built_pairs, total: r.total_pairs };
            }
            setLiveProgress(prog);
            const allDone = (statusData.resolutions || []).every(
              (r: any) => r.status === 'complete' || r.status === 'error'
            );
            if (allDone && pollRef.current) {
              clearInterval(pollRef.current);
              pollRef.current = null;
              setIsBuilding(false);
              refreshExisting();
            }
          } catch {}
        }, 5000);
      }
    } catch (err: any) {
      setIsBuilding(false);
      setBuildStatus([{ region: selectedRegion, resolution: -1, status: 'error', stage: 'CONNECTION_ERROR', total_origins: 0, processed_origins: 0, total_pairs: 0, built_pairs: 0, percent_complete: 0, elapsed_seconds: 0, est_remaining_seconds: 0, hexagons: 0, work_queue: 0, raw_ingested: 0, flattened: 0, error: `Service unavailable — please wait a moment and try again. (${err.message})` }]);
    }
  }, [selectedRegion, selectedRes, refreshExisting]);

  useEffect(() => {
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, []);

  if (!open) return null;

  const readyRegions = regions.filter((r) => r.ready);
  const notReadyRegions = regions.filter((r) => !r.ready && r.provisioned);
  const noService = regions.filter((r) => !r.ready && !r.provisioned);
  const isSuspended = region?.serviceStatus === 'SUSPENDED';

  const savings = estimate.api_comparison.map((api) => ({
    ...api,
    savings: api.total_cost - estimate.snowflake_cost,
    savingsPercent: estimate.snowflake_cost > 0 && api.total_cost > 0
      ? ((api.total_cost - estimate.snowflake_cost) / api.total_cost) * 100
      : 0,
  }));

  return (
    <div className="matrix-overlay" onClick={onClose}>
      <div className="matrix-modal" onClick={(e) => e.stopPropagation()}>
        <div className="matrix-header">
          <div className="matrix-header-left">
            <svg viewBox="0 0 24 24" fill="none" width="22" height="22">
              <rect x="2" y="2" width="8" height="8" rx="1" fill="#FF6B35" opacity="0.8" />
              <rect x="14" y="2" width="8" height="8" rx="1" fill="#FF6B35" opacity="0.5" />
              <rect x="2" y="14" width="8" height="8" rx="1" fill="#FF6B35" opacity="0.5" />
              <rect x="14" y="14" width="8" height="8" rx="1" fill="#FF6B35" opacity="0.3" />
              <path d="M10 6h4M6 10v4M18 10v4M10 18h4" stroke="#FF6B35" strokeWidth="1.5" />
            </svg>
            <div>
              <div className="matrix-title">Travel Time Matrix Builder</div>
              <div className="matrix-subtitle">Pre-compute driving times between H3 hexagons using OpenRouteService</div>
            </div>
          </div>
          <button className="matrix-close" onClick={onClose}>×</button>
        </div>

        <div className="matrix-body">
          <div className="matrix-section">
            <div className="matrix-section-title">1. Select Region</div>
            {loadingRegions ? (
              <div style={{ padding: '16px 0', color: 'var(--sb-text-secondary)', fontSize: 13 }}>Checking provisioned ORS regions...</div>
            ) : readyRegions.length === 0 && notReadyRegions.length === 0 ? (
              <div className="data-complete-banner" style={{ background: 'rgba(255, 107, 53, 0.08)', border: '1px solid rgba(255, 107, 53, 0.2)' }}>
                <div className="data-complete-text" style={{ color: 'var(--sb-text-secondary)' }}>
                  No ORS regions are provisioned yet. Use the <strong>Data Builder</strong> to set up a city first — it will create the compute pool, ORS service, and MATRIX function needed for matrix builds.
                </div>
              </div>
            ) : (
              <div className="matrix-region-grid">
                {readyRegions.map((r) => (
                  <button
                    key={r.region}
                    className={`matrix-region-card ${selectedRegion === r.region ? 'active' : ''}`}
                    onClick={() => setSelectedRegion(r.region)}
                  >
                    <div className="matrix-region-name">
                      <span className="data-service-dot" style={{ background: r.serviceStatus === 'RUNNING' ? '#30D158' : '#FF9500', width: 8, height: 8, borderRadius: '50%', display: 'inline-block', marginRight: 6 }} />
                      {r.label}
                    </div>
                    <div className="matrix-region-desc">
                      {r.cities.length > 1 ? `${r.cities.length} cities` : r.cities[0] || r.label} — ORS {r.serviceStatus}
                      {r.serviceStatus === 'SUSPENDED' && ' (will auto-resume)'}
                    </div>
                  </button>
                ))}
              </div>
            )}
            {noService.length > 0 && readyRegions.length > 0 && (
              <div style={{ marginTop: 8, fontSize: 12, color: 'var(--sb-text-tertiary)' }}>
                {noService.length} other region{noService.length > 1 ? 's' : ''} available — provision via Data Builder first
              </div>
            )}
          </div>

          {region && regionReady && (
            <>
              <div className="matrix-section">
                <div className="matrix-section-title">2. Select Resolutions</div>
                <div className="matrix-res-grid">
                  {hexEstimates.map((h) => (
                    <label key={h.res} className={`matrix-res-card ${selectedRes.has(h.res) ? 'active' : ''}`}>
                      <input
                        type="checkbox"
                        checked={selectedRes.has(h.res)}
                        onChange={() => toggleRes(h.res)}
                      />
                      <div className="matrix-res-info">
                        <div className="matrix-res-label">Res {h.res} — {RES_LABELS[h.res]}</div>
                        <div className="matrix-res-detail">
                          ~{formatNumber(h.hexagons)} hexagons · {RES_CUTOFFS[h.res]}mi cutoff · ~{formatNumber(h.pairs)} pairs
                        </div>
                      </div>
                    </label>
                  ))}
                </div>
              </div>

              <div className="matrix-section">
                <div className="matrix-section-title">3. Resource Estimate</div>
                <div className="matrix-estimate-grid">
                  <div className="matrix-estimate-card primary">
                    <div className="matrix-estimate-label">Total Pairs</div>
                    <div className="matrix-estimate-value">~{formatNumber(estimate.total_pairs)}</div>
                  </div>
                  <div className="matrix-estimate-card">
                    <div className="matrix-estimate-label">Est. Compute Time</div>
                    <div className="matrix-estimate-value">{formatDuration(estimate.total_time_minutes)}</div>
                  </div>
                  <div className="matrix-estimate-card">
                    <div className="matrix-estimate-label">Snowflake Credits</div>
                    <div className="matrix-estimate-value">{estimate.total_credits.toFixed(1)}</div>
                  </div>
                  <div className="matrix-estimate-card highlight">
                    <div className="matrix-estimate-label">Est. Snowflake Cost</div>
                    <div className="matrix-estimate-value">{formatCost(estimate.snowflake_cost)}</div>
                  </div>
                </div>

                {estimate.resolutions.length > 0 && (
                  <table className="matrix-detail-table">
                    <thead>
                      <tr>
                        <th>Resolution</th>
                        <th>Hexagons</th>
                        <th>Cutoff</th>
                        <th>Pairs</th>
                        <th>Time</th>
                        <th>Credits</th>
                      </tr>
                    </thead>
                    <tbody>
                      {estimate.resolutions.map((r) => (
                        <tr key={r.res}>
                          <td>Res {r.res} ({r.label.split('(')[0].trim()})</td>
                          <td>~{formatNumber(r.hexagons)}</td>
                          <td>{r.cutoff_miles} mi</td>
                          <td>~{formatNumber(r.sparse_pairs)}</td>
                          <td>{formatDuration(r.est_time_minutes)}</td>
                          <td>{r.est_credits.toFixed(2)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </div>

              <div className="matrix-section">
                <div className="matrix-section-title">4. Cost Comparison vs External APIs</div>
                <div className="matrix-comparison-note">
                  Computing ~{formatNumber(estimate.total_pairs)} origin-destination travel times for {region.label}
                </div>
                <table className="matrix-detail-table comparison">
                  <thead>
                    <tr>
                      <th>Provider</th>
                      <th>Cost/Element</th>
                      <th>Total Cost</th>
                      <th>vs Snowflake</th>
                    </tr>
                  </thead>
                  <tbody>
                    {savings.map((s) => (
                      <tr key={s.provider}>
                        <td>{s.provider}</td>
                        <td>{formatCost(s.cost_per_call)}</td>
                        <td className="api-cost">{formatCost(s.total_cost)}</td>
                        <td className="savings">
                          {s.savings > 0 ? (
                            <span className="savings-positive">{s.savingsPercent.toFixed(0)}% cheaper on Snowflake</span>
                          ) : (
                            <span className="savings-neutral">Similar cost</span>
                          )}
                        </td>
                      </tr>
                    ))}
                    <tr className="snowflake-row">
                      <td><strong>Snowflake + ORS Native App</strong></td>
                      <td>—</td>
                      <td className="snowflake-cost">{formatCost(estimate.snowflake_cost)}</td>
                      <td className="savings"><span className="savings-label">Baseline</span></td>
                    </tr>
                  </tbody>
                </table>
                <div className="matrix-comparison-footnote">
                  Snowflake cost based on Small warehouse ({CREDIT_PER_HOUR_SMALL} credits/hr) at $2.50/credit.
                  External API costs are per-element pricing from public rate cards. Snowflake processes the matrix
                  in-platform with no data egress, using the {region.matrixFn} function.
                </div>
              </div>
            </>
          )}

          {(buildStatus.length > 0 || isBuilding) && (
            <div className="matrix-section">
              <div className="matrix-section-title">Build Progress</div>
              {buildStatus.map((bs) => {
                const stageIdx = getStageIndex(bs.stage || 'NOT_STARTED');
                return (
                <div key={bs.resolution} className="matrix-progress-card">
                  <div className="matrix-progress-header">
                    <span className="matrix-progress-label">
                      {bs.resolution === -1 ? 'Connection Error' : `Resolution ${bs.resolution} — ${RES_LABELS[bs.resolution] || ''}`}
                    </span>
                    <span className={`matrix-progress-status status-${bs.status}`}>
                      {bs.status === 'building' && '⟳ '}
                      {bs.status === 'complete' && '✓ '}
                      {bs.status === 'error' && '✕ '}
                      {bs.stage || bs.status}
                    </span>
                  </div>
                  <div className="matrix-stage-pipeline">
                    {STAGE_STEPS.map((step, i) => {
                      const isActive = i === stageIdx;
                      const isDone = i < stageIdx;
                      const isPending = i > stageIdx;
                      return (
                        <div key={step.key} className={`matrix-stage-step ${isActive ? 'active' : ''} ${isDone ? 'done' : ''} ${isPending ? 'pending' : ''}`}>
                          <div className="matrix-stage-icon">{isDone ? '✓' : step.icon}</div>
                          <div className="matrix-stage-label">{step.label}</div>
                        </div>
                      );
                    })}
                  </div>
                  <div className="matrix-progress-bar-bg">
                    <div
                      className="matrix-progress-bar-fill"
                      style={{ width: `${Math.min(bs.percent_complete, 100)}%` }}
                    />
                  </div>
                  <div className="matrix-progress-stats">
                    <span>{formatNumber(bs.raw_ingested || bs.built_pairs)} / {formatNumber(bs.work_queue || bs.total_pairs)} origins</span>
                    <span>{bs.percent_complete.toFixed(1)}%</span>
                    {bs.status === 'building' && bs.est_remaining_seconds > 0 && (
                      <span>~{formatDuration(bs.est_remaining_seconds / 60)} remaining</span>
                    )}
                  </div>
                  <div className="matrix-progress-detail">
                    <span title="Hexagon cells generated">{formatNumber(bs.hexagons || 0)} hex</span>
                    <span title="Origins queued for API calls">{formatNumber(bs.work_queue || 0)} queued</span>
                    <span title="Raw API responses ingested">{formatNumber(bs.raw_ingested || 0)} raw</span>
                    <span title="Final travel time pairs after flatten">{formatNumber(bs.flattened || 0)} pairs</span>
                  </div>
                  {bs.error && <div className="matrix-progress-error">{bs.error}</div>}
                </div>
                );
              })}
            </div>
          )}

          {!isBuilding && buildStatus.length > 0 && buildStatus.every((bs) => bs.status === 'complete' || bs.status === 'error') && (
            <div className="matrix-section">
              <div className="matrix-section-title">Build Summary</div>
              <div className="matrix-summary-diagram">
                <table className="matrix-summary-table">
                  <thead>
                    <tr>
                      <th>Table</th>
                      {buildStatus.map((bs) => (
                        <th key={bs.resolution}>Res {bs.resolution}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    <tr>
                      <td className="matrix-summary-label">
                        <span className="matrix-summary-icon">⬡</span> H3 Hexagons
                      </td>
                      {buildStatus.map((bs) => (
                        <td key={bs.resolution} className={bs.hexagons > 0 ? 'matrix-summary-ok' : 'matrix-summary-zero'}>
                          {formatNumber(bs.hexagons || 0)}
                        </td>
                      ))}
                    </tr>
                    <tr>
                      <td className="matrix-summary-label">
                        <span className="matrix-summary-icon">📋</span> Work Queue
                      </td>
                      {buildStatus.map((bs) => (
                        <td key={bs.resolution} className={bs.work_queue > 0 ? 'matrix-summary-ok' : 'matrix-summary-zero'}>
                          {formatNumber(bs.work_queue || 0)}
                        </td>
                      ))}
                    </tr>
                    <tr>
                      <td className="matrix-summary-label">
                        <span className="matrix-summary-icon">⟳</span> Raw Ingested
                      </td>
                      {buildStatus.map((bs) => (
                        <td key={bs.resolution} className={(bs.raw_ingested || 0) > 0 ? 'matrix-summary-ok' : 'matrix-summary-zero'}>
                          {formatNumber(bs.raw_ingested || 0)}
                        </td>
                      ))}
                    </tr>
                    <tr className="matrix-summary-highlight">
                      <td className="matrix-summary-label">
                        <span className="matrix-summary-icon">✓</span> Travel Time Pairs
                      </td>
                      {buildStatus.map((bs) => (
                        <td key={bs.resolution} className={(bs.flattened || 0) > 0 ? 'matrix-summary-ok' : 'matrix-summary-zero'}>
                          <strong>{formatNumber(bs.flattened || 0)}</strong>
                        </td>
                      ))}
                    </tr>
                    <tr>
                      <td className="matrix-summary-label">Status</td>
                      {buildStatus.map((bs) => (
                        <td key={bs.resolution} className={`matrix-summary-status-${bs.status}`}>
                          {bs.status === 'complete' ? '✓ Complete' : '✕ Error'}
                        </td>
                      ))}
                    </tr>
                  </tbody>
                </table>
                <div className="matrix-summary-pipeline">
                  <span className="matrix-pipeline-step">⬡ Hexagons</span>
                  <span className="matrix-pipeline-arrow">→</span>
                  <span className="matrix-pipeline-step">📋 Queue</span>
                  <span className="matrix-pipeline-arrow">→</span>
                  <span className="matrix-pipeline-step">⟳ ORS API</span>
                  <span className="matrix-pipeline-arrow">→</span>
                  <span className="matrix-pipeline-step">⚡ Flatten</span>
                  <span className="matrix-pipeline-arrow">→</span>
                  <span className="matrix-pipeline-step">✓ Travel Times</span>
                </div>
              </div>
            </div>
          )}
        </div>

        {modalView === 'confirm-remove' && (
          <div className="matrix-danger-overlay">
            <div className="matrix-danger-modal">
              <div className="matrix-danger-icon">⚠️</div>
              <div className="matrix-danger-title">Remove {selectedRegion || 'All'} Matrix Data</div>
              <div className="matrix-danger-text">
                This will remove travel time data{selectedRegion ? ` for ${selectedRegion}` : ''} across all 3 resolutions, removing <strong>{formatNumber(totalExisting)}</strong> rows.
                Rebuild time depends on region size, warehouse config, and ORS instance count.
              </div>
              <div className="matrix-sql-preview">
                <div className="matrix-sql-label">SQL to be executed:</div>
                <pre className="matrix-sql-code">{selectedRegion ? `DELETE FROM DATA.CA_TRAVEL_TIME_RES7 WHERE REGION = '${selectedRegion}';
DELETE FROM DATA.CA_TRAVEL_TIME_RES8 WHERE REGION = '${selectedRegion}';
DELETE FROM DATA.CA_TRAVEL_TIME_RES9 WHERE REGION = '${selectedRegion}';` : `TRUNCATE TABLE DATA.CA_TRAVEL_TIME_RES7;
TRUNCATE TABLE DATA.CA_TRAVEL_TIME_RES8;
TRUNCATE TABLE DATA.CA_TRAVEL_TIME_RES9;`}</pre>
              </div>
              <div className="matrix-danger-note">
                You can restore this data using <strong>Snowflake Time Travel</strong> (up to 90 days) — see the Restore option after removal.
              </div>
              <div className="matrix-danger-actions">
                <button className="matrix-btn secondary" onClick={() => setModalView('main')}>Cancel</button>
                <button className="matrix-btn danger" onClick={executeRemove}>Remove {selectedRegion || 'All'} Matrix Data</button>
              </div>
            </div>
          </div>
        )}

        {modalView === 'removing' && (
          <div className="matrix-danger-overlay">
            <div className="matrix-danger-modal">
              <div className="matrix-danger-icon">⟳</div>
              <div className="matrix-danger-title">Removing matrix data...</div>
              <div className="matrix-danger-text">Truncating tables. This should only take a few seconds.</div>
            </div>
          </div>
        )}

        {modalView === 'removed' && (
          <div className="matrix-danger-overlay">
            <div className="matrix-danger-modal">
              <div className="matrix-danger-icon">{Object.values(removeResults).every((r) => r.status === 'removed') ? '✓' : '✕'}</div>
              <div className="matrix-danger-title">Matrix Data Removed</div>
              <div className="matrix-results-list">
                {Object.entries(removeResults).map(([res, r]) => (
                  <div key={res} className={`matrix-result-row ${r.status}`}>
                    <span className="matrix-result-table">{r.table.split('.').pop()}</span>
                    <span className="matrix-result-detail">
                      {r.status === 'removed' ? `${formatNumber(r.rows_before)} rows removed` : r.status}
                    </span>
                  </div>
                ))}
              </div>
              <div className="matrix-danger-actions">
                <button className="matrix-btn secondary" onClick={() => setModalView('main')}>Back to Builder</button>
                <button className="matrix-btn restore" onClick={() => setModalView('confirm-restore')}>Restore with Time Travel</button>
              </div>
            </div>
          </div>
        )}

        {modalView === 'confirm-restore' && (
          <div className="matrix-danger-overlay">
            <div className="matrix-danger-modal">
              <div className="matrix-danger-icon">⏪</div>
              <div className="matrix-danger-title">Restore {selectedRegion || 'All'} Matrix via Time Travel</div>
              <div className="matrix-danger-text">
                Snowflake <strong>Time Travel</strong> lets you query historical table data.
                This will INSERT {selectedRegion ? `${selectedRegion} ` : ''}rows from the table state <strong>{restoreMinutes} minutes ago</strong> back into the current table.
              </div>
              <div className="matrix-restore-offset">
                <label>Restore from how many minutes ago?</label>
                <div className="matrix-restore-slider">
                  <input
                    type="range"
                    min={1}
                    max={1440}
                    value={restoreMinutes}
                    onChange={(e) => setRestoreMinutes(Number(e.target.value))}
                  />
                  <span className="matrix-restore-value">{restoreMinutes < 60 ? `${restoreMinutes} min` : `${(restoreMinutes / 60).toFixed(1)} hrs`}</span>
                </div>
              </div>
              <div className="matrix-sql-preview">
                <div className="matrix-sql-label">SQL to be executed:</div>
                <pre className="matrix-sql-code">{selectedRegion ? `-- Snowflake Time Travel: OFFSET => -${restoreMinutes * 60} seconds
-- Restores ${selectedRegion} travel times from ${restoreMinutes} min ago

INSERT INTO DATA.CA_TRAVEL_TIME_RES7
  SELECT * FROM DATA.CA_TRAVEL_TIME_RES7
  AT(OFFSET => -${restoreMinutes * 60})
  WHERE REGION = '${selectedRegion}';
-- (repeated for RES8, RES9)` : `-- Snowflake Time Travel: OFFSET => -${restoreMinutes * 60} seconds
-- Restores all travel times from ${restoreMinutes} min ago

INSERT INTO DATA.CA_TRAVEL_TIME_RES7
  SELECT * FROM DATA.CA_TRAVEL_TIME_RES7
  AT(OFFSET => -${restoreMinutes * 60});
-- (repeated for RES8, RES9)`}</pre>
              </div>
              <div className="matrix-danger-note">
                Time Travel is available for up to <strong>90 days</strong> (default retention). The offset should be set to a time <em>before</em> the TRUNCATE was executed.
              </div>
              <div className="matrix-danger-actions">
                <button className="matrix-btn secondary" onClick={() => setModalView('removed')}>Back</button>
                <button className="matrix-btn restore" onClick={executeRestore}>Restore Data</button>
              </div>
            </div>
          </div>
        )}

        {modalView === 'restoring' && (
          <div className="matrix-danger-overlay">
            <div className="matrix-danger-modal">
              <div className="matrix-danger-icon">⟳</div>
              <div className="matrix-danger-title">Restoring matrix data...</div>
              <div className="matrix-danger-text">Inserting historical rows via Time Travel. This may take a minute for large tables.</div>
            </div>
          </div>
        )}

        {modalView === 'restored' && (
          <div className="matrix-danger-overlay">
            <div className="matrix-danger-modal">
              <div className="matrix-danger-icon">{Object.values(restoreResults).every((r) => r.status === 'restored') ? '✓' : '✕'}</div>
              <div className="matrix-danger-title">Matrix Data Restored</div>
              <div className="matrix-results-list">
                {Object.entries(restoreResults).map(([res, r]) => (
                  <div key={res} className={`matrix-result-row ${r.status}`}>
                    <span className="matrix-result-table">{r.table.split('.').pop()}</span>
                    <span className="matrix-result-detail">
                      {r.status === 'restored' ? `${formatNumber(r.rows_restored)} rows restored` : r.status}
                    </span>
                  </div>
                ))}
              </div>
              <div className="matrix-danger-actions">
                <button className="matrix-btn primary" onClick={() => setModalView('main')}>Back to Builder</button>
              </div>
            </div>
          </div>
        )}

        <div className="matrix-footer">
          <div className="matrix-footer-info">
            {!loadingExisting && existingCounts && Object.keys(existingCounts).length > 0 && (
              <span className="matrix-existing">
                Existing: {Object.entries(existingCounts).map(([k, v]) =>
                  `${k}: ${formatNumber(v as number)}`
                ).join(' · ')}
              </span>
            )}
          </div>
          <div className="matrix-footer-actions">
            <button
              className="matrix-btn danger-outline"
              onClick={() => setModalView('confirm-remove')}
              disabled={isBuilding || !hasExistingData}
              title={hasExistingData ? 'Remove all matrix data' : 'No matrix data to remove'}
            >
              Remove Matrix
            </button>
            <button
              className="matrix-btn restore-outline"
              onClick={() => setModalView('confirm-restore')}
              disabled={isBuilding}
            >
              Restore Matrix
            </button>
            <button className="matrix-btn secondary" onClick={onClose}>Cancel</button>
            <button
              className="matrix-btn primary"
              onClick={startBuild}
              disabled={isBuilding || selectedRes.size === 0 || !regionReady}
            >
              {isBuilding ? 'Building...' : regionReady ? `Build Matrix for ${region?.label || 'Region'}${isSuspended ? ' (will resume ORS)' : ''}` : 'Select a ready region'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

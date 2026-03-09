import React, { useState, useEffect, useCallback, useRef } from 'react';
import type { MatrixEstimate, MatrixBuildStatus } from '../types';

interface Props {
  open: boolean;
  onClose: () => void;
}

interface RegionOption {
  id: string;
  label: string;
  description: string;
  hexEstimates: { res: number; hexagons: number; pairs: number }[];
}

const REGIONS: RegionOption[] = [
  {
    id: 'san_francisco',
    label: 'San Francisco',
    description: 'Single city — ideal for testing. ~1,065 hexagons at res 9. Measured: 3 min.',
    hexEstimates: [
      { res: 9, hexagons: 1065, pairs: 1134225 },
      { res: 8, hexagons: 180, pairs: 32400 },
      { res: 7, hexagons: 30, pairs: 900 },
    ],
  },
  {
    id: 'los_angeles',
    label: 'Los Angeles',
    description: 'Largest CA city. ~18,000 hexagons at res 9.',
    hexEstimates: [
      { res: 9, hexagons: 18000, pairs: 1800000 },
      { res: 8, hexagons: 3200, pairs: 4500000 },
      { res: 7, hexagons: 520, pairs: 270000 },
    ],
  },
  {
    id: 'san_diego',
    label: 'San Diego',
    description: '~12,000 hexagons at res 9.',
    hexEstimates: [
      { res: 9, hexagons: 12000, pairs: 1200000 },
      { res: 8, hexagons: 2100, pairs: 2800000 },
      { res: 7, hexagons: 350, pairs: 122500 },
    ],
  },
  {
    id: 'bay_area',
    label: 'SF Bay Area',
    description: 'San Francisco, Oakland, San Jose, Berkeley. ~45,000 hexagons at res 9.',
    hexEstimates: [
      { res: 9, hexagons: 45000, pairs: 4500000 },
      { res: 8, hexagons: 7500, pairs: 12000000 },
      { res: 7, hexagons: 1200, pairs: 1440000 },
    ],
  },
  {
    id: 'socal',
    label: 'Southern California',
    description: 'LA, San Diego, Anaheim, Irvine, Long Beach, etc. ~120,000 hexagons at res 9.',
    hexEstimates: [
      { res: 9, hexagons: 120000, pairs: 5000000 },
      { res: 8, hexagons: 20000, pairs: 18000000 },
      { res: 7, hexagons: 3500, pairs: 8000000 },
    ],
  },
  {
    id: 'all_cities',
    label: 'All 20 Cities',
    description: 'City-scoped matrices for all 20 California delivery cities only.',
    hexEstimates: [
      { res: 9, hexagons: 250000, pairs: 25000000 },
      { res: 8, hexagons: 42000, pairs: 35000000 },
      { res: 7, hexagons: 7000, pairs: 15000000 },
    ],
  },
  {
    id: 'all_california',
    label: 'All California (Statewide)',
    description: 'Full statewide coverage — every H3 hex across CA. 1.95B pairs. Measured: ~6.5 hours, 132 credits. X-Small warehouse × 10 clusters + 10 ORS nodes + X-Large flatten.',
    hexEstimates: [
      { res: 9, hexagons: 8562468, pairs: 1133551374 },
      { res: 8, hexagons: 1202530, pairs: 526323579 },
      { res: 7, hexagons: 177365, pairs: 277834651 },
    ],
  },
];

const RES_LABELS: Record<number, string> = {
  9: 'Last Mile (174m)',
  8: 'Delivery Zone (460m)',
  7: 'Long Range (1.2km)',
};

const RES_CUTOFFS: Record<number, number> = { 9: 2, 8: 10, 7: 50 };

const RATE_PAIRS_PER_SEC = 31500;
const RATE_PAIRS_PER_SEC_PARALLEL = 90000;
const CREDIT_PER_HOUR_XSMALL = 1;
const CREDIT_PER_HOUR_SMALL = 2;
const STATEWIDE_WH_CREDITS_PER_HR = 10;
const STATEWIDE_COMPUTE_POOL_PER_HR = 10;
const STATEWIDE_FLATTEN_CREDITS = 2;
const STATEWIDE_TOTAL_CREDITS = 132;

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
  sql: string;
}

interface RestoreResult {
  table: string;
  rows_restored: number;
  status: string;
  sql: string;
}

export default function MatrixBuilder({ open, onClose }: Props) {
  const [selectedRegion, setSelectedRegion] = useState<string>('san_francisco');
  const [selectedRes, setSelectedRes] = useState<Set<number>>(new Set([9, 8, 7]));
  const [buildStatus, setBuildStatus] = useState<MatrixBuildStatus[]>([]);
  const [isBuilding, setIsBuilding] = useState(false);
  const [liveProgress, setLiveProgress] = useState<Record<string, { built: number; total: number }>>({});
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const [existingCounts, setExistingCounts] = useState<Record<string, number>>({});
  const [loadingExisting, setLoadingExisting] = useState(false);
  const [modalView, setModalView] = useState<ModalView>('main');
  const [removeResults, setRemoveResults] = useState<Record<number, RemoveResult>>({});
  const [restoreResults, setRestoreResults] = useState<Record<number, RestoreResult>>({});
  const [restoreMinutes, setRestoreMinutes] = useState(5);

  const refreshExisting = useCallback(() => {
    setLoadingExisting(true);
    fetch('/api/matrix/existing')
      .then((r) => r.json())
      .then((data) => {
        setExistingCounts(data);
        setLoadingExisting(false);
      })
      .catch(() => setLoadingExisting(false));
  }, []);

  useEffect(() => {
    if (!open) return;
    setModalView('main');
    refreshExisting();
  }, [open, refreshExisting]);

  const hasExistingData = Object.values(existingCounts).some((v) => (v as number) > 0);
  const totalExisting = Object.values(existingCounts).reduce((s, v) => s + (v as number), 0);

  const executeRemove = useCallback(async () => {
    setModalView('removing');
    try {
      const resp = await fetch(`/api/matrix/remove?resolutions=7,8,9`, { method: 'DELETE' });
      const data = await resp.json();
      setRemoveResults(data.resolutions || {});
      setModalView('removed');
      refreshExisting();
    } catch (err: any) {
      setRemoveResults({ 0: { table: 'error', rows_before: 0, status: 'error', sql: err.message } });
      setModalView('removed');
    }
  }, [refreshExisting]);

  const executeRestore = useCallback(async () => {
    setModalView('restoring');
    try {
      const resp = await fetch('/api/matrix/restore', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ resolutions: [7, 8, 9], offset_minutes: restoreMinutes }),
      });
      const data = await resp.json();
      setRestoreResults(data.resolutions || {});
      setModalView('restored');
      refreshExisting();
    } catch (err: any) {
      setRestoreResults({ 0: { table: 'error', rows_restored: 0, status: 'error', sql: err.message } });
      setModalView('restored');
    }
  }, [restoreMinutes, refreshExisting]);

  const region = REGIONS.find((r) => r.id === selectedRegion)!;

  const isStatewide = selectedRegion === 'all_california';
  const effectiveRate = isStatewide ? RATE_PAIRS_PER_SEC_PARALLEL : RATE_PAIRS_PER_SEC;
  const creditRate = isStatewide ? STATEWIDE_WH_CREDITS_PER_HR : CREDIT_PER_HOUR_SMALL;
  const warehouseSize = isStatewide ? 'X-Small × 10 multi-cluster' : 'Small';

  const estimate = React.useMemo(() => {
    const resolutions = region.hexEstimates
      .filter((h) => selectedRes.has(h.res))
      .map((h) => {
        const timeMin = h.pairs / effectiveRate / 60;
        const credits = (timeMin / 60) * creditRate;
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
    const totalTime = isStatewide
      ? resolutions.reduce((s, r) => s + r.est_time_minutes, 0) * 0.35
      : resolutions.reduce((s, r) => s + r.est_time_minutes, 0);
    const totalCredits = isStatewide
      ? STATEWIDE_TOTAL_CREDITS
      : (totalTime / 60) * creditRate;

    const apiComparisons = [
      {
        provider: 'Google Distance Matrix API',
        cost_per_call: 0.005,
        calls_needed: totalPairs,
        total_cost: totalPairs * 0.005,
      },
      {
        provider: 'HERE Matrix Routing',
        cost_per_call: 0.0035,
        calls_needed: totalPairs,
        total_cost: totalPairs * 0.0035,
      },
      {
        provider: 'Mapbox Matrix API',
        cost_per_call: 0.0004,
        calls_needed: totalPairs,
        total_cost: totalPairs * 0.0004,
      },
    ];

    return {
      region: region.label,
      resolutions,
      total_pairs: totalPairs,
      total_time_minutes: totalTime,
      total_credits: totalCredits,
      snowflake_cost: totalCredits * 2.5,
      api_comparison: apiComparisons,
    } as MatrixEstimate;
  }, [region, selectedRes, effectiveRate, creditRate, isStatewide]);

  const toggleRes = (res: number) => {
    setSelectedRes((prev) => {
      const next = new Set(prev);
      if (next.has(res)) next.delete(res);
      else next.add(res);
      return next;
    });
  };

  const startBuild = useCallback(async () => {
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
            }
          } catch {}
        }, 5000);
      }
    } catch (err: any) {
      setIsBuilding(false);
      setBuildStatus([{ region: selectedRegion, resolution: 0, status: 'error', total_origins: 0, processed_origins: 0, total_pairs: 0, built_pairs: 0, percent_complete: 0, elapsed_seconds: 0, est_remaining_seconds: 0, error: err.message }]);
    }
  }, [selectedRegion, selectedRes]);

  useEffect(() => {
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, []);

  if (!open) return null;

  const savings = estimate.api_comparison.map((api) => ({
    ...api,
    savings: api.total_cost - estimate.snowflake_cost,
    savingsPercent: ((api.total_cost - estimate.snowflake_cost) / api.total_cost) * 100,
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
            <div className="matrix-region-grid">
              {REGIONS.map((r) => (
                <button
                  key={r.id}
                  className={`matrix-region-card ${selectedRegion === r.id ? 'active' : ''} ${r.id === 'all_california' ? 'statewide' : ''}`}
                  onClick={() => setSelectedRegion(r.id)}
                >
                  <div className="matrix-region-name">{r.label}</div>
                  <div className="matrix-region-desc">{r.description}</div>
                  {r.id === 'all_california' && (
                    <div className="matrix-region-badge">1.95B pairs</div>
                  )}
                </button>
              ))}
            </div>
          </div>

          <div className="matrix-section">
            <div className="matrix-section-title">2. Select Resolutions</div>
            <div className="matrix-res-grid">
              {region.hexEstimates.map((h) => (
                <label key={h.res} className={`matrix-res-card ${selectedRes.has(h.res) ? 'active' : ''}`}>
                  <input
                    type="checkbox"
                    checked={selectedRes.has(h.res)}
                    onChange={() => toggleRes(h.res)}
                  />
                  <div className="matrix-res-info">
                    <div className="matrix-res-label">Res {h.res} — {RES_LABELS[h.res]}</div>
                    <div className="matrix-res-detail">
                      {formatNumber(h.hexagons)} hexagons · {RES_CUTOFFS[h.res]}mi cutoff · {formatNumber(h.pairs)} pairs
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
                <div className="matrix-estimate-value">{formatNumber(estimate.total_pairs)}</div>
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
                      <td>{formatNumber(r.hexagons)}</td>
                      <td>{r.cutoff_miles} mi</td>
                      <td>{formatNumber(r.sparse_pairs)}</td>
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
              Computing {formatNumber(estimate.total_pairs)} origin-destination travel times
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
                  <td>
                    <strong>Snowflake + ORS Native App</strong>
                  </td>
                  <td>—</td>
                  <td className="snowflake-cost">{formatCost(estimate.snowflake_cost)}</td>
                  <td className="savings"><span className="savings-label">Baseline</span></td>
                </tr>
              </tbody>
            </table>
            <div className="matrix-comparison-footnote">
              Snowflake cost based on {warehouseSize} warehouse ({creditRate} credits/hr) at $2.50/credit.
              {isStatewide && ` Measured: 132 credits (~$396) for 1.95B pairs in ~6.5 hours. Infrastructure: X-Small warehouse × 10 multi-cluster (10 cr/hr) for parallel workers, 10-node compute pool (10 cr/hr) for ORS routing engine, plus X-Large warehouse (~2 credits) for FLATTEN post-processing. Workers scale back as resolutions complete. `}
              External API costs are per-element pricing from public rate cards. Snowflake processes the matrix
              in-platform with no data egress, using the ORS Native App MATRIX function.
            </div>
          </div>

          {(buildStatus.length > 0 || isBuilding) && (
            <div className="matrix-section">
              <div className="matrix-section-title">Build Progress</div>
              {buildStatus.map((bs) => (
                <div key={bs.resolution} className="matrix-progress-card">
                  <div className="matrix-progress-header">
                    <span className="matrix-progress-label">
                      Resolution {bs.resolution} — {RES_LABELS[bs.resolution] || ''}
                    </span>
                    <span className={`matrix-progress-status status-${bs.status}`}>
                      {bs.status === 'building' && '⟳ '}
                      {bs.status === 'complete' && '✓ '}
                      {bs.status === 'error' && '✕ '}
                      {bs.status}
                    </span>
                  </div>
                  <div className="matrix-progress-bar-bg">
                    <div
                      className="matrix-progress-bar-fill"
                      style={{ width: `${Math.min(bs.percent_complete, 100)}%` }}
                    />
                  </div>
                  <div className="matrix-progress-stats">
                    <span>{formatNumber(bs.built_pairs)} / {formatNumber(bs.total_pairs)} pairs</span>
                    <span>{bs.percent_complete.toFixed(1)}%</span>
                    {bs.status === 'building' && bs.est_remaining_seconds > 0 && (
                      <span>~{formatDuration(bs.est_remaining_seconds / 60)} remaining</span>
                    )}
                  </div>
                  {bs.error && <div className="matrix-progress-error">{bs.error}</div>}
                </div>
              ))}
            </div>
          )}
        </div>

        {modalView === 'confirm-remove' && (
          <div className="matrix-danger-overlay">
            <div className="matrix-danger-modal">
              <div className="matrix-danger-icon">⚠️</div>
              <div className="matrix-danger-title">Remove All Matrix Data</div>
              <div className="matrix-danger-text">
                This will <strong>TRUNCATE</strong> all three travel time tables, removing <strong>{formatNumber(totalExisting)}</strong> rows.
                This data took ~6.5 hours and 132 credits (~$396) to compute.
              </div>
              <div className="matrix-sql-preview">
                <div className="matrix-sql-label">SQL to be executed:</div>
                <pre className="matrix-sql-code">{`TRUNCATE TABLE OPENROUTESERVICE_SETUP.PUBLIC.CA_TRAVEL_TIME_RES7;
TRUNCATE TABLE OPENROUTESERVICE_SETUP.PUBLIC.CA_TRAVEL_TIME_RES8;
TRUNCATE TABLE OPENROUTESERVICE_SETUP.PUBLIC.CA_TRAVEL_TIME_RES9;`}</pre>
              </div>
              <div className="matrix-danger-note">
                You can restore this data using <strong>Snowflake Time Travel</strong> (up to 90 days) — see the Restore option after removal.
              </div>
              <div className="matrix-danger-actions">
                <button className="matrix-btn secondary" onClick={() => setModalView('main')}>Cancel</button>
                <button className="matrix-btn danger" onClick={executeRemove}>Remove All Matrix Data</button>
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
                      {r.status === 'removed' ? `${formatNumber(r.rows_before)} rows removed` : r.sql}
                    </span>
                  </div>
                ))}
              </div>
              <div className="matrix-sql-preview">
                <div className="matrix-sql-label">Executed:</div>
                <pre className="matrix-sql-code">{Object.values(removeResults).map((r) => r.sql).join('\n')}</pre>
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
              <div className="matrix-danger-title">Restore Matrix via Time Travel</div>
              <div className="matrix-danger-text">
                Snowflake <strong>Time Travel</strong> lets you query historical table data.
                This will INSERT all rows from the table state <strong>{restoreMinutes} minutes ago</strong> back into the current (empty) table.
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
                <div className="matrix-sql-label">SQL to be executed (Time Travel):</div>
                <pre className="matrix-sql-code">{`-- Snowflake Time Travel: OFFSET => seconds before present
-- Restores data from ${restoreMinutes} minutes ago

INSERT INTO OPENROUTESERVICE_SETUP.PUBLIC.CA_TRAVEL_TIME_RES7
  SELECT * FROM OPENROUTESERVICE_SETUP.PUBLIC.CA_TRAVEL_TIME_RES7
  AT(OFFSET => -${restoreMinutes * 60});

INSERT INTO OPENROUTESERVICE_SETUP.PUBLIC.CA_TRAVEL_TIME_RES8
  SELECT * FROM OPENROUTESERVICE_SETUP.PUBLIC.CA_TRAVEL_TIME_RES8
  AT(OFFSET => -${restoreMinutes * 60});

INSERT INTO OPENROUTESERVICE_SETUP.PUBLIC.CA_TRAVEL_TIME_RES9
  SELECT * FROM OPENROUTESERVICE_SETUP.PUBLIC.CA_TRAVEL_TIME_RES9
  AT(OFFSET => -${restoreMinutes * 60});`}</pre>
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
                      {r.status === 'restored' ? `${formatNumber(r.rows_restored)} rows restored` : r.sql}
                    </span>
                  </div>
                ))}
              </div>
              <div className="matrix-sql-preview">
                <div className="matrix-sql-label">Executed:</div>
                <pre className="matrix-sql-code">{Object.values(restoreResults).map((r) => r.sql).join('\n')}</pre>
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
            {hasExistingData && (
              <button
                className="matrix-btn danger-outline"
                onClick={() => setModalView('confirm-remove')}
                disabled={isBuilding}
              >
                Remove Matrix
              </button>
            )}
            {!hasExistingData && (
              <button
                className="matrix-btn restore-outline"
                onClick={() => setModalView('confirm-restore')}
              >
                Restore Matrix
              </button>
            )}
            <button className="matrix-btn secondary" onClick={onClose}>Cancel</button>
            <button
              className="matrix-btn primary"
              onClick={startBuild}
              disabled={isBuilding || selectedRes.size === 0}
            >
              {isBuilding ? 'Building...' : `Build Matrix (${formatNumber(estimate.total_pairs)} pairs)`}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

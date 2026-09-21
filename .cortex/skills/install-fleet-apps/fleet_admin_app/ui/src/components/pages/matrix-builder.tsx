'use client';
import React, { useState, useEffect, useCallback, useRef } from 'react';
import type { MatrixJob, MatrixInventoryItem, RegionInfo } from '@/lib/types';
import { RES_LABELS, RES_CUTOFFS } from '@/lib/types';
import { safeFetchJson } from '@/utils/safeFetch';
import {
  RATE_PAIRS_PER_SEC, CREDIT_PER_HOUR_SMALL, ALL_RESOLUTIONS,
  estimateHexCount, estimatePairs,
  formatNumber, formatDuration, formatBytes, timeAgo,
  STAGE_STEPS, getStageIndex, RoadFilterBadge,
} from '@/components/matrix-builder/helpers';
import { PROFILE_LABELS } from '@/components/function-tester/helpers';
import { useActivePreset } from '@/hooks/useActivePreset';
import PresetRoutingControls from '@/components/shared/PresetRoutingControls';
import { useVisiblePolling } from '@/hooks/useVisiblePolling';

export function MatrixBuilderPage() {
  const preset = useActivePreset();
  const [regions, setRegions] = useState<RegionInfo[]>([]);
  const [loadingRegions, setLoadingRegions] = useState(true);
  const [selectedRegion, setSelectedRegion] = useState<string>('');
  const [selectedProfile, setSelectedProfile] = useState<string>(preset.orsProfile);
  const [availableProfiles, setAvailableProfiles] = useState<string[]>([]);
  const [profilesLoading, setProfilesLoading] = useState(false);
  const [selectedRes, setSelectedRes] = useState<Set<number>>(new Set([7, 8, 9]));
  const [jobs, setJobs] = useState<MatrixJob[]>([]);
  const [inventory, setInventory] = useState<MatrixInventoryItem[]>([]);
  const [isLaunching, setIsLaunching] = useState(false);
  const [buildError, setBuildError] = useState<string | null>(null);
  const [buildWarning, setBuildWarning] = useState<string | null>(null);
  const [deletingKey, setDeletingKey] = useState<string | null>(null);
  const [dismissedErrors, setDismissedErrors] = useState<Set<string>>(new Set());
  const [roadFilterEnabled, setRoadFilterEnabled] = useState(true);
  const [roadFilterAvailable, setRoadFilterAvailable] = useState<boolean | null>(null);
  const [roadFilterReason, setRoadFilterReason] = useState<string>('');
  const [serverHexEstimate, setServerHexEstimate] = useState<Record<number, number>>({});
  const [estimateLoading, setEstimateLoading] = useState(false);
  const estimateGenRef = useRef(0);

  const fetchRegions = useCallback(async () => {
    setLoadingRegions(true);
    const { ok, data } = await safeFetchJson<{ regions: RegionInfo[] }>('/api/matrix/regions');
    if (ok && data) {
      const fetched = data.regions || [];
      setRegions(fetched);
      if (fetched.length > 0 && !selectedRegion) {
        const fromPreset = fetched.find((r) => r.region === preset.region);
        const sf = fetched.find((r) => r.region.toUpperCase() === 'SANFRANCISCO');
        const running = fetched.find((r) => r.serviceStatus === 'RUNNING');
        setSelectedRegion((fromPreset || sf || running || fetched[0]).region);
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

  const fetchProfiles = useCallback(async (region: string) => {
    if (!region) {
      setAvailableProfiles([]);
      return;
    }
    setProfilesLoading(true);
    try {
      const resp = await fetch('/api/query', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sql: `SELECT CORE.ORS_STATUS('${region.replace(/'/g, "''")}')` }),
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
            }
            setProfilesLoading(false);
            return;
          }
        }
      }
    } catch {}
    setAvailableProfiles([]);
    setProfilesLoading(false);
  }, [selectedProfile]);

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
  }, [fetchRegions, fetchJobs, fetchInventory]);

  useEffect(() => {
    if (preset.loading) return;
    if (preset.region) setSelectedRegion(preset.region);
    if (preset.orsProfile) setSelectedProfile(preset.orsProfile);
  }, [preset.region, preset.orsProfile, preset.loading]);

  useEffect(() => {
    if (!selectedRegion) return;
    void fetchProfiles(selectedRegion);
  }, [selectedRegion, fetchProfiles]);

  // Road-aware hexagon estimate. The road-aware SQL in /api/matrix/cost-estimate
  // keys off region bbox/polygon and resolution ONLY - `selectedProfile` never
  // enters the query, so it is deliberately NOT a dependency here. Adding it back
  // makes every profile switch fire a fresh multi-second Overture SEGMENT scan
  // that cannot change the answer.
  useEffect(() => {
    if (!roadFilterEnabled || !roadFilterAvailable || !selectedRegion || selectedRes.size === 0) {
      // Orphan any in-flight run and release the latch: with the road filter off
      // there is nothing to estimate, so leaving `estimateLoading` set here is
      // what previously pinned the UI at "Estimating..." with no way back.
      estimateGenRef.current++;
      setServerHexEstimate({});
      setEstimateLoading(false);
      return;
    }
    const gen = ++estimateGenRef.current;
    const controller = new AbortController();
    const timer = setTimeout(async () => {
      setEstimateLoading(true);
      try {
        const { ok, data, error, aborted } = await safeFetchJson<{ resolutions: any[] }>('/api/matrix/cost-estimate', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            region: selectedRegion,
            profile: selectedProfile,
            resolutions: Array.from(selectedRes).sort(),
            road_filter: true,
          }),
          signal: controller.signal,
        });
        // Stale response: a newer run has started, so its result wins. Guard the
        // state WRITES only - the finally block below must still run.
        if (estimateGenRef.current !== gen || aborted) return;
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
      } finally {
        // Unconditional release for the latest run, on every exit path.
        if (estimateGenRef.current === gen) setEstimateLoading(false);
      }
    }, 500);
    return () => { controller.abort(); clearTimeout(timer); };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- selectedProfile is sent for logging only; see comment above.
  }, [roadFilterEnabled, roadFilterAvailable, selectedRegion, selectedRes]);

  // Poll while a matrix job is in flight, paused whenever the tab is hidden.
  // A matrix build is a long job, so 10s loses nothing versus the previous 5s.
  const hasActiveMatrixJob = jobs.some((j) => j.status === 'RUNNING' || j.status === 'PENDING');
  const pollMatrix = useCallback(() => { fetchJobs(); fetchInventory(); }, [fetchJobs, fetchInventory]);
  useVisiblePolling(pollMatrix, 10000, hasActiveMatrixJob);

  // Preserve the original final refresh: the inventory is only correct once the
  // last job has left RUNNING/PENDING, so fetch once on the active -> idle edge.
  // Dropping this would leave the page showing pre-build inventory forever.
  const wasActiveRef = useRef(false);
  useEffect(() => {
    if (wasActiveRef.current && !hasActiveMatrixJob) fetchInventory();
    wasActiveRef.current = hasActiveMatrixJob;
  }, [hasActiveMatrixJob, fetchInventory]);

  const region = regions.find((r) => r.region === selectedRegion);

  const hexEstimates = React.useMemo(() => {
    if (!region) return [];
    return ALL_RESOLUTIONS.map((res) => {
      const bboxHexagons = estimateHexCount(region, res);
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
    setBuildWarning(null);
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
      if (data.warning) setBuildWarning(data.warning);
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
                    <td>{item.resolution} - {RES_LABELS[parseInt(item.resolution.replace('RES', ''))] || ''}<RoadFilterBadge on={item.road_filter} /></td>
                    <td>{formatNumber(item.row_count)}</td>
                    <td>{formatBytes(item.bytes)}</td>
                    <td>{item.execution_time_secs > 0 ? formatDuration(item.execution_time_secs / 60) : '-'}</td>
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
                  <span>{job.region} / {job.profile} / {job.resolution} - {RES_LABELS[resNum] || ''}<RoadFilterBadge on={job.road_filter} /></span>
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
                    {/* Explain a shrinking cell count rather than letting it look
                        like data loss. These exclusions happen whether or not
                        Road-Aware Filtering is on, because a cell the routing
                        graph cannot reach produces no travel times either way. */}
                    {!!job.hexagons_before_routability
                      && !!job.hexagons_after_routability
                      && job.hexagons_before_routability > job.hexagons_after_routability && (
                      <div style={{ fontSize: 11, color: 'var(--text-secondary)', marginTop: 6 }}>
                        {formatNumber(job.hexagons_after_routability)} of {formatNumber(job.hexagons_before_routability)} cells are reachable by road;
                        {' '}{formatNumber(job.hexagons_before_routability - job.hexagons_after_routability)} excluded as unroutable.
                      </div>
                    )}
                    {!!job.filter_warning && (
                      <div style={{ fontSize: 11, color: '#f9a825', marginTop: 6 }}>{job.filter_warning}</div>
                    )}
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
                    <strong>{job.region} / {job.profile} / {job.resolution} - {RES_LABELS[resNum] || ''}<RoadFilterBadge on={job.road_filter} /></strong>
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
                {!!job.routability_note && (
                  <div style={{ fontSize: 11, color: 'var(--text-secondary)', marginTop: 6 }}>{job.routability_note}</div>
                )}
                {!!job.filter_warning && (
                  <div style={{ fontSize: 11, color: '#f9a825', marginTop: 6 }}>{job.filter_warning}</div>
                )}
              </div>
            );
          })}
        </>
      )}

      <h3>{inventory.length > 0 || activeJobs.length > 0 ? 'New Build' : 'Region & Routing Profile'}</h3>
      {!loadingRegions && readyRegions.length > 0 && (
        <div style={{ marginBottom: 12 }}>
          <PresetRoutingControls
            region={selectedRegion || preset.region}
            profile={selectedProfile}
            onChange={({ region, profile }) => {
              setSelectedRegion(region);
              setSelectedProfile(profile);
            }}
            regions={readyRegions.map((r) => ({ value: r.region, label: r.label }))}
            profiles={
              profilesLoading
                ? [{ value: selectedProfile, label: 'Loading...' }]
                : availableProfiles.length > 0
                  ? availableProfiles.map((p) => ({ value: p, label: PROFILE_LABELS[p] || p }))
                  : [{ value: selectedProfile, label: PROFILE_LABELS[selectedProfile] || selectedProfile }]
            }
          />
        </div>
      )}
      {loadingRegions ? (
        <div className="loading-text">Checking provisioned ORS regions...</div>
      ) : readyRegions.length === 0 ? (
        <div className="empty-state">No ORS regions provisioned. Use the Cities tab to deploy a region first.</div>
      ) : null}

      {region && (
        <>
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
                {/* Not "bbox": the build tessellates the region BOUNDARY polygon
                    whenever the catalog has one, and land-clips it either way.
                    Off means a uniform grid over the region, which is a valid
                    coverage choice - it does not mean unroutable cells. */}
                {roadFilterAvailable === true && !roadFilterEnabled && 'Disabled - uniform grid over the whole region (unroutable cells are still excluded)'}
              </div>
            </div>
          </label>

          <h3>Select Resolutions</h3>
          <div className="res-grid">
            {hexEstimates.map((h) => (
              <label key={h.res} className={`res-card ${selectedRes.has(h.res) ? 'active' : ''}`}>
                <input type="checkbox" checked={selectedRes.has(h.res)} onChange={() => toggleRes(h.res)} />
                <div>
                  <div className="res-label">Res {h.res} - {RES_LABELS[h.res]}<RoadFilterBadge on={roadFilterEnabled && roadFilterAvailable === true} /></div>
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
        {/* The estimate is ADVISORY: displayed pairs/credits already fall back to
            the bbox figure, so a pending road-aware refinement must not block the
            build. Progress is signalled by the "(recalculating...)" label above. */}
        <button className="btn primary" onClick={startBuild} disabled={isLaunching || selectedRes.size === 0 || !region?.ready}>
          {isLaunching ? 'Launching...' : `Build Matrix for ${region?.label || 'Region'}`}
        </button>
      </div>
      {buildWarning && (
        <div className="warning-banner" style={{ marginTop: 8 }}>
          <strong>Heads up:</strong> {buildWarning}
        </div>
      )}
      {buildError && (
        <div className="error-banner" style={{ marginTop: 8 }}>
          <strong>Build failed:</strong> {buildError}
        </div>
      )}
    </div>
  );
}

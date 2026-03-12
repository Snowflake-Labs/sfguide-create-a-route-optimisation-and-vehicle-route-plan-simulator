import React, { useState, useCallback, useEffect, useRef } from 'react';
import { CITY_NAMES } from '../types';

interface Props {
  open: boolean;
  onClose: () => void;
  initialCity: string;
}

interface CityStatus {
  city: string;
  region: string;
  orsServiceStatus: string;
  orsServiceExists: boolean;
  pbfDownloaded: boolean;
  directionsFunctionExists: boolean;
  downloaderReady: boolean;
  orsReady: boolean;
  hasData: boolean;
  provisionState: string;
  provisionMessage?: string;
  provisionError?: string;
  dataSteps?: StepProgress[];
}

interface StepProgress {
  step: string;
  status: string;
  message?: string;
  rows?: number;
  elapsed_seconds?: number;
  started_at?: number;
}

interface ProvisionProgress {
  status: string;
  message?: string;
  error?: string;
  orsRegion: string;
  dataSteps?: StepProgress[];
}

const SHIFT_PRESETS: Record<number, { breakfast: number; lunch: number; afternoon: number; dinner: number; late_night: number }> = {
  20: { breakfast: 2, lunch: 6, afternoon: 3, dinner: 7, late_night: 2 },
  50: { breakfast: 5, lunch: 15, afternoon: 8, dinner: 17, late_night: 5 },
  100: { breakfast: 10, lunch: 30, afternoon: 15, dinner: 35, late_night: 10 },
  200: { breakfast: 20, lunch: 60, afternoon: 30, dinner: 70, late_night: 20 },
};

function getShiftDistribution(total: number) {
  const preset = SHIFT_PRESETS[total];
  if (preset) return preset;
  return {
    breakfast: Math.round(total * 0.1),
    lunch: Math.round(total * 0.3),
    afternoon: Math.round(total * 0.16),
    dinner: Math.round(total * 0.34),
    late_night: Math.round(total * 0.1),
  };
}

function formatNumber(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M';
  if (n >= 1_000) return (n / 1_000).toFixed(1) + 'K';
  return n.toLocaleString();
}

function formatDuration(seconds: number): string {
  if (seconds < 60) return `${Math.round(seconds)}s`;
  const mins = Math.floor(seconds / 60);
  const secs = Math.round(seconds % 60);
  if (mins < 60) return secs > 0 ? `${mins}m ${secs}s` : `${mins}m`;
  const hrs = Math.floor(mins / 60);
  const remMins = mins % 60;
  return remMins > 0 ? `${hrs}h ${remMins}m` : `${hrs}h`;
}

const PROVISION_PHASES = [
  { id: 'downloading_pbf', label: 'Download Map Data', icon: '📦' },
  { id: 'creating_pool', label: 'Create Compute Pool', icon: '🖥' },
  { id: 'creating_service', label: 'Start ORS Service', icon: '🔧' },
  { id: 'building_graph', label: 'Build Routing Graph', icon: '🗺' },
  { id: 'creating_functions', label: 'Create Functions', icon: '⚡' },
];

const DATA_STEPS = [
  { id: 'restaurants', label: 'Load Restaurants', desc: 'From Overture Maps Places' },
  { id: 'addresses', label: 'Load Customer Addresses', desc: 'From Overture Maps Addresses' },
  { id: 'couriers', label: 'Create Couriers', desc: 'Shift patterns & vehicle types' },
  { id: 'orders', label: 'Generate Delivery Orders', desc: 'Order assignments per courier' },
  { id: 'routes', label: 'Generate ORS Routes', desc: 'Actual road routing via OpenRouteService' },
  { id: 'geometries', label: 'Parse Routes & Geometries', desc: 'Timing, distances, route lines' },
  { id: 'locations', label: 'Interpolate Courier Locations', desc: 'Positions along routes with speeds' },
];

const PROVISION_STATUS_ORDER = ['idle', 'downloading_pbf', 'creating_pool', 'creating_service', 'building_graph', 'creating_functions', 'ready', 'building_data', 'complete'];

export default function DataBuilder({ open, onClose, initialCity }: Props) {
  const [city, setCity] = useState(initialCity !== 'All Cities' ? initialCity : CITY_NAMES[0]);
  const [numCouriers, setNumCouriers] = useState(50);
  const [numDays, setNumDays] = useState(1);
  const [startDate, setStartDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [cityStatus, setCityStatus] = useState<CityStatus | null>(null);
  const [loading, setLoading] = useState(false);
  const [progress, setProgress] = useState<ProvisionProgress | null>(null);
  const [isBuilding, setIsBuilding] = useState(false);
  const [tickCount, setTickCount] = useState(0);
  const [deleting, setDeleting] = useState(false);
  const [restoring, setRestoring] = useState(false);
  const [actionMessage, setActionMessage] = useState<string | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const tickRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    if (open && initialCity && initialCity !== 'All Cities') {
      setCity(initialCity);
    }
  }, [open, initialCity]);

  const fetchStatus = useCallback(async () => {
    if (!city) return;
    setLoading(true);
    try {
      const r = await fetch(`/api/city/${encodeURIComponent(city)}/status`);
      const data = await r.json();
      setCityStatus(data);
    } catch {}
    setLoading(false);
  }, [city]);

  useEffect(() => {
    if (!open) return;
    setCityStatus(null);
    setProgress(null);
    setIsBuilding(false);
    setActionMessage(null);
    fetchStatus();
    return () => {
      if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; }
      if (tickRef.current) { clearInterval(tickRef.current); tickRef.current = null; }
    };
  }, [open, city, fetchStatus]);

  const startProvision = useCallback(async () => {
    if (!city) return;
    setIsBuilding(true);
    setProgress(null);
    setTickCount(0);

    tickRef.current = setInterval(() => setTickCount((c) => c + 1), 1000);

    try {
      const shifts = getShiftDistribution(numCouriers);
      const resp = await fetch(`/api/city/${encodeURIComponent(city)}/provision`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ num_couriers: numCouriers, num_days: numDays, start_date: startDate, shifts }),
      });
      const data = await resp.json();
      if (data.status === 'started' || data.error?.includes('already in progress')) {
        pollRef.current = setInterval(async () => {
          try {
            const pr = await fetch(`/api/city/${encodeURIComponent(city)}/progress`);
            const pd: ProvisionProgress = await pr.json();
            setProgress(pd);
            if (pd.status === 'complete' || pd.status === 'error') {
              if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; }
              if (tickRef.current) { clearInterval(tickRef.current); tickRef.current = null; }
              setIsBuilding(false);
              fetchStatus();
            }
          } catch {}
        }, 2000);
      }
    } catch (err: any) {
      setIsBuilding(false);
      if (tickRef.current) { clearInterval(tickRef.current); tickRef.current = null; }
      setProgress({ status: 'error', error: err.message, orsRegion: '' });
    }
  }, [city, numCouriers, numDays, startDate, fetchStatus]);

  const deleteData = useCallback(async () => {
    if (!city) return;
    setDeleting(true);
    setActionMessage(null);
    try {
      const r = await fetch(`/api/city/${encodeURIComponent(city)}/data`, { method: 'DELETE' });
      const data = await r.json();
      if (data.status === 'removed') {
        setActionMessage(`Data deleted for ${city}`);
        fetchStatus();
      } else {
        setActionMessage(`Delete failed: ${data.error || 'Unknown error'}`);
      }
    } catch (err: any) {
      setActionMessage(`Delete failed: ${err.message}`);
    }
    setDeleting(false);
  }, [city, fetchStatus]);

  const restoreData = useCallback(async () => {
    if (!city) return;
    setRestoring(true);
    setActionMessage(null);
    try {
      const r = await fetch(`/api/city/${encodeURIComponent(city)}/restore`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ offset_minutes: 10 }),
      });
      const data = await r.json();
      if (data.status === 'restored') {
        setActionMessage(`Data restored for ${city}`);
        fetchStatus();
      } else {
        setActionMessage(`Restore failed: ${data.error || 'Unknown error'}`);
      }
    } catch (err: any) {
      setActionMessage(`Restore failed: ${err.message}`);
    }
    setRestoring(false);
  }, [city, fetchStatus]);

  if (!open) return null;

  const shifts = getShiftDistribution(numCouriers);
  const estOrders = numCouriers * 12 * numDays;
  const orsReady = cityStatus?.orsReady ?? false;
  const hasData = cityStatus?.hasData ?? false;
  const provStatus = progress?.status || cityStatus?.provisionState || 'idle';
  const isActive = isBuilding || (provStatus !== 'idle' && provStatus !== 'complete' && provStatus !== 'error');

  const provPhaseIdx = PROVISION_STATUS_ORDER.indexOf(provStatus);
  const dataSteps = progress?.dataSteps || cityStatus?.dataSteps || [];
  const completedDataSteps = dataSteps.filter((s) => s.status === 'complete').length;
  const runningDataStep = dataSteps.find((s) => s.status === 'running');
  const waitingForOrsStep = dataSteps.find((s) => s.status === 'waiting_for_ors');
  void tickCount;

  return (
    <div className="matrix-overlay" onClick={onClose}>
      <div className="matrix-modal" onClick={(e) => e.stopPropagation()}>
        <div className="matrix-header">
          <div className="matrix-header-left">
            <svg viewBox="0 0 24 24" fill="none" width="22" height="22">
              <path d="M12 2C8.13 2 5 5.13 5 9c0 3.54 2.29 6.53 5.47 7.59.4.07.53-.18.53-.4v-1.49c-2.22.48-2.69-1.07-2.69-1.07-.36-.92-.89-1.17-.89-1.17-.73-.5.05-.49.05-.49.8.06 1.23.82 1.23.82.71 1.22 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82A7.66 7.66 0 0112 6.8c.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.74.54 1.49v2.21c0 .21.14.46.55.38A8.013 8.013 0 0019 9c0-3.87-3.13-7-7-7z" fill="#FF6B35" opacity="0.9"/>
              <circle cx="8" cy="18" r="2" fill="#FF6B35"/>
              <circle cx="16" cy="18" r="2" fill="#FF6B35"/>
              <path d="M8 18h8" stroke="#FF6B35" strokeWidth="2"/>
              <path d="M12 14v4" stroke="#FF6B35" strokeWidth="1.5"/>
            </svg>
            <div>
              <div className="matrix-title">Data Builder</div>
              <div className="matrix-subtitle">Provision routing service & generate delivery data</div>
            </div>
          </div>
          <button className="matrix-close" onClick={onClose}>×</button>
        </div>

        <div className="matrix-body">
          <div className="matrix-section">
            <div className="matrix-section-title">Select City</div>
            <select
              className="city-select"
              value={city}
              onChange={(e) => setCity(e.target.value)}
              disabled={isActive}
              style={{ width: '100%', marginBottom: 8 }}
            >
              {CITY_NAMES.map((c) => (
                <option key={c} value={c}>{c}</option>
              ))}
            </select>
          </div>

          <div className="matrix-section">
            <div className="matrix-section-title">ORS Region: {cityStatus?.region || '...'}</div>
            <div className="data-services-grid" style={{ gridTemplateColumns: 'repeat(4, 1fr)' }}>
              <div className={`data-service-card ${cityStatus?.downloaderReady ? 'running' : 'stopped'}`}>
                <span className="data-service-dot" />
                <div className="data-service-info">
                  <span className="data-service-name">Downloader</span>
                  <span className="data-service-status">{cityStatus?.downloaderReady ? 'Ready' : 'Not started'}</span>
                </div>
              </div>
              <div className={`data-service-card ${cityStatus?.pbfDownloaded ? 'running' : 'stopped'}`}>
                <span className="data-service-dot" />
                <div className="data-service-info">
                  <span className="data-service-name">Map Data</span>
                  <span className="data-service-status">{cityStatus?.pbfDownloaded ? 'Downloaded' : 'Not downloaded'}</span>
                </div>
              </div>
              <div className={`data-service-card ${cityStatus?.orsServiceStatus === 'RUNNING' ? 'running' : 'stopped'}`}>
                <span className="data-service-dot" />
                <div className="data-service-info">
                  <span className="data-service-name">ORS Service</span>
                  <span className="data-service-status">{cityStatus?.orsServiceStatus || 'Unknown'}</span>
                </div>
              </div>
              <div className={`data-service-card ${hasData ? 'running' : 'stopped'}`}>
                <span className="data-service-dot" />
                <div className="data-service-info">
                  <span className="data-service-name">Delivery Data</span>
                  <span className="data-service-status">{hasData ? 'Ready' : 'No data'}</span>
                </div>
              </div>
            </div>
          </div>

          {!isActive && (
            <div className="matrix-section">
              <div className="matrix-section-title">Fleet Configuration</div>
              <div className="data-config-grid">
                <div className="data-config-item">
                  <label>Couriers</label>
                  <div className="data-slider-row">
                    <input type="range" min={10} max={200} step={10} value={numCouriers} onChange={(e) => setNumCouriers(Number(e.target.value))} />
                    <span className="data-slider-value">{numCouriers}</span>
                  </div>
                  <div className="data-shift-breakdown">
                    Breakfast: {shifts.breakfast} · Lunch: {shifts.lunch} · Afternoon: {shifts.afternoon} · Dinner: {shifts.dinner} · Late Night: {shifts.late_night}
                  </div>
                </div>
                <div className="data-config-item">
                  <label>Simulation Days</label>
                  <div className="data-slider-row">
                    <input type="range" min={1} max={14} value={numDays} onChange={(e) => setNumDays(Number(e.target.value))} />
                    <span className="data-slider-value">{numDays} day{numDays > 1 ? 's' : ''}</span>
                  </div>
                  {numDays > 1 && (
                    <div className="data-shift-breakdown">Today = active deliveries · {numDays - 1} past day{numDays > 2 ? 's' : ''} = completed</div>
                  )}
                </div>
                <div className="data-config-item">
                  <label>Start Date (Today)</label>
                  <input type="date" className="data-date-input" value={startDate} onChange={(e) => setStartDate(e.target.value)} />
                </div>
              </div>
              <div className="matrix-estimate-grid" style={{ marginTop: 12 }}>
                <div className="matrix-estimate-card primary">
                  <div className="matrix-estimate-label">Couriers</div>
                  <div className="matrix-estimate-value">{numCouriers}</div>
                </div>
                <div className="matrix-estimate-card">
                  <div className="matrix-estimate-label">Est. Orders</div>
                  <div className="matrix-estimate-value">{formatNumber(estOrders)}</div>
                </div>
                <div className="matrix-estimate-card">
                  <div className="matrix-estimate-label">Location Points</div>
                  <div className="matrix-estimate-value">{formatNumber(estOrders * 15)}</div>
                </div>
              </div>
            </div>
          )}

          {isActive && (
            <div className="matrix-section">
              <div className="matrix-section-title">
                {provPhaseIdx < 7 ? 'Provisioning ORS...' : waitingForOrsStep ? `Waiting for ORS — Steps 1-4 complete` : `Building Data — Step ${runningDataStep ? DATA_STEPS.findIndex((s) => s.id === runningDataStep.step) + 1 : completedDataSteps} / ${DATA_STEPS.length}`}
              </div>

              {provPhaseIdx > 0 && provPhaseIdx < 7 && (
                <div style={{ marginBottom: 12 }}>
                  {PROVISION_PHASES.map((phase) => {
                    const phIdx = PROVISION_STATUS_ORDER.indexOf(phase.id);
                    const isDone = provPhaseIdx > phIdx;
                    const isCurrent = provStatus === phase.id;
                    return (
                      <div key={phase.id} className={`matrix-progress-card ${isCurrent ? 'card-running' : ''}`} style={{ opacity: isDone || isCurrent ? 1 : 0.4 }}>
                        <div className="matrix-progress-header">
                          <span className="matrix-progress-label">
                            <span className="build-step-num">{phase.icon}</span>
                            {phase.label}
                          </span>
                          <span className={`matrix-progress-status ${isDone ? 'status-complete' : isCurrent ? 'status-running' : ''}`}>
                            {isDone ? '✓' : isCurrent ? <span className="spin-icon">⟳</span> : ''}
                          </span>
                        </div>
                        {isCurrent && (
                          <div className="matrix-progress-bar-bg">
                            <div className="matrix-progress-bar-fill data-indeterminate" />
                          </div>
                        )}
                        {isCurrent && progress?.message && (
                          <div className="matrix-progress-stats"><span>{progress.message}</span></div>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}

              {provPhaseIdx >= 7 && dataSteps.length > 0 && (
                <>
                  <div className="build-step-bar">
                    {DATA_STEPS.map((step) => {
                      const prog = dataSteps.find((s) => s.step === step.id);
                      return <div key={step.id} className={`build-step-segment ${prog?.status || 'idle'}`} />;
                    })}
                  </div>
                  {DATA_STEPS.map((step, i) => {
                    const prog = dataSteps.find((s) => s.step === step.id);
                    const st = prog?.status || 'idle';
                    const isWaiting = st === 'idle' && isActive;
                    const isWaitingOrs = st === 'waiting_for_ors';
                    const liveElapsed = (st === 'running' || isWaitingOrs) && prog?.started_at ? (Date.now() - prog.started_at) / 1000 : 0;
                    return (
                      <div key={step.id} className={`matrix-progress-card ${st === 'running' ? 'card-running' : ''} ${isWaitingOrs ? 'card-running' : ''} ${isWaiting ? 'card-waiting' : ''}`}>
                        <div className="matrix-progress-header">
                          <span className="matrix-progress-label">
                            <span className="build-step-num">{i + 1}</span>
                            {step.label}
                          </span>
                          <span className={`matrix-progress-status status-${isWaitingOrs ? 'running' : st}${isWaiting ? ' status-waiting' : ''}`}>
                            {(st === 'running' || isWaitingOrs) && <span className="spin-icon">⟳</span>}
                            {st === 'complete' && '✓ '}
                            {st === 'error' && '✕ '}
                            {isWaitingOrs ? 'waiting for ORS' : st === 'running' ? 'running' : isWaiting ? 'waiting' : st}
                          </span>
                        </div>
                        {(st === 'running' || isWaitingOrs) && (
                          <div className="matrix-progress-bar-bg">
                            <div className="matrix-progress-bar-fill data-indeterminate" />
                          </div>
                        )}
                        {st === 'complete' && (
                          <div className="matrix-progress-bar-bg">
                            <div className="matrix-progress-bar-fill" style={{ width: '100%' }} />
                          </div>
                        )}
                        <div className="matrix-progress-stats">
                          {(st === 'running' || isWaitingOrs) && <span className="live-elapsed">{formatDuration(liveElapsed)}</span>}
                          {prog?.message && <span>{prog.message}</span>}
                          {prog?.rows !== undefined && prog.rows > 0 && <span>{formatNumber(prog.rows)} rows</span>}
                          {st === 'complete' && prog?.elapsed_seconds !== undefined && <span>{formatDuration(prog.elapsed_seconds)}</span>}
                        </div>
                      </div>
                    );
                  })}
                </>
              )}
            </div>
          )}

          {provStatus === 'error' && (
            <div className="matrix-section">
              <div className="data-complete-banner" style={{ background: 'rgba(255, 59, 48, 0.08)', border: '1px solid rgba(255, 59, 48, 0.2)' }}>
                <div className="data-complete-icon" style={{ color: '#FF3B30' }}>✕</div>
                <div className="data-complete-text" style={{ color: '#FF3B30' }}>
                  {progress?.error || cityStatus?.provisionError || 'Build failed'}
                </div>
              </div>
            </div>
          )}

          {(provStatus === 'complete' || hasData) && !isActive && (
            <div className="matrix-section">
              <div className="data-complete-banner">
                <div className="data-complete-icon">✓</div>
                <div className="data-complete-text">
                  {city} is ready! Delivery routes and courier locations are now visible on the map.
                </div>
              </div>
            </div>
          )}

          {!isActive && (
            <div className="matrix-section">
              <div style={{ display: 'flex', gap: 8 }}>
                {hasData && (
                  <button
                    className="matrix-btn secondary"
                    onClick={deleteData}
                    disabled={deleting || restoring}
                    style={{ flex: 1, background: 'rgba(255, 59, 48, 0.08)', borderColor: 'rgba(255, 59, 48, 0.3)', color: '#FF3B30' }}
                  >
                    {deleting ? 'Deleting...' : 'Delete City Data'}
                  </button>
                )}
                <button
                  className="matrix-btn secondary"
                  onClick={restoreData}
                  disabled={deleting || restoring}
                  style={{ flex: 1, background: 'rgba(48, 209, 88, 0.08)', borderColor: 'rgba(48, 209, 88, 0.3)', color: '#30D158' }}
                >
                  {restoring ? 'Restoring...' : 'Restore (Time Travel)'}
                </button>
              </div>
              {actionMessage && (
                <div style={{ marginTop: 8, padding: '8px 12px', borderRadius: 6, background: 'rgba(255, 255, 255, 0.04)', fontSize: 13, color: 'var(--sb-text-secondary)' }}>
                  {actionMessage}
                </div>
              )}
            </div>
          )}
        </div>

        <div className="matrix-footer">
          <div className="matrix-footer-info">
            {loading && <span className="matrix-existing">Checking...</span>}
          </div>
          <div className="matrix-footer-actions">
            <button className="matrix-btn secondary" onClick={onClose}>
              {hasData || provStatus === 'complete' ? 'Done' : 'Cancel'}
            </button>
            {!hasData && provStatus !== 'complete' && (
              <button
                className="matrix-btn primary"
                onClick={startProvision}
                disabled={isActive || loading}
              >
                {isActive ? 'Building...' : `Build ${city}`}
              </button>
            )}
            {hasData && !isActive && (
              <button
                className="matrix-btn primary"
                onClick={async () => {
                  await deleteData();
                  setTimeout(() => startProvision(), 500);
                }}
                disabled={deleting || restoring}
              >
                Rebuild Data
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

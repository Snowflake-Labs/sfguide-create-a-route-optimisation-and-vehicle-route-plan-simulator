import { useState, useEffect, useCallback, useRef } from 'react';
import { PieChart, Pie, Cell, Tooltip, ResponsiveContainer } from 'recharts';
import { CarTaxiFront, Bike, Truck, Play, Square, Save, ChevronDown, ChevronRight, CheckCircle, AlertCircle, Clock, Database, Trash2 } from 'lucide-react';
import MetricCard from '../shared/MetricCard';


interface Preset {
  preset_id: string;
  name: string;
  ors_profile: string;
  region: string;
  config: any;
  is_builtin: boolean;
}

interface ProfileTemplate {
  id: string;
  name: string;
  description: string;
  vehicleType: string;
  orsProfile: string;
  regionScale: string;
  feeds: string[];
  defaultConfig: any;
}

interface JobInfo {
  jobId: string;
  presetName: string;
  region: string;
  orsProfile: string;
  vehicleType: string;
  status: string;
  pointsGenerated: number;
  tripsGenerated: number;
  startedAt: string;
}

interface CoverageEntry {
  VEHICLE_TYPE: string;
  REGION: string;
  ORS_PROFILE: string;
  TELEMETRY_ROWS: number;
  TRIP_ROWS: number;
  VEHICLES: number;
}

const VEHICLE_ICONS: Record<string, any> = {
  car: CarTaxiFront,
  ebike: Bike,
  hgv: Truck,
};

const VEHICLE_COLORS: Record<string, string> = {
  car: '#29B5E8',
  ebike: '#4CAF50',
  hgv: '#FF9800',
};

const VEHICLE_LABELS: Record<string, string> = {
  car: 'City Taxis',
  ebike: 'E-Bike Couriers',
  hgv: 'HGV Logistics',
};

const SKILL_MAP: Record<string, string> = {
  'dwell-analysis': 'Dwell Analysis',
  'fleet-intelligence-taxis': 'Fleet Taxis',
  'fleet-intelligence-food-delivery': 'Food Delivery',
  'route-deviation': 'Route Deviation',
};

const PIE_COLORS = ['#29B5E8', '#4CAF50', '#FF9800', '#E91E63', '#9C27B0'];

export default function FleetDataStudio() {
  const [templates, setTemplates] = useState<ProfileTemplate[]>([]);
  const [presets, setPresets] = useState<Preset[]>([]);
  const [selectedTemplate, setSelectedTemplate] = useState<ProfileTemplate | null>(null);
  const [selectedPreset, setSelectedPreset] = useState<Preset | null>(null);
  const [editConfig, setEditConfig] = useState<any>(null);
  const [editName, setEditName] = useState('');
  const [editRegion, setEditRegion] = useState('SanFrancisco');
  const [editProfile, setEditProfile] = useState('driving-car');
  const [activeJobs, setActiveJobs] = useState<JobInfo[]>([]);
  const [jobHistory, setJobHistory] = useState<any[]>([]);
  const [generating, setGenerating] = useState(false);
  const [deletingJob, setDeletingJob] = useState<string | null>(null);
  const [logLines, setLogLines] = useState<string[]>([]);
  const [stats, setStats] = useState<any[]>([]);
  const [coverage, setCoverage] = useState<CoverageEntry[]>([]);
  const [expandedSections, setExpandedSections] = useState<Set<string>>(new Set(['fleet', 'time']));
  const logRef = useRef<HTMLDivElement>(null);
  const evtSourceRef = useRef<EventSource | null>(null);
  const retryCountRef = useRef(0);
  const retryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const reconnectedRef = useRef(false);

  const fetchTemplates = useCallback(async () => {
    try {
      const res = await fetch('/api/studio/templates');
      setTemplates(await res.json());
    } catch (e: any) {
      console.error('Failed to fetch templates:', e);
    }
  }, []);

  const fetchPresets = useCallback(async () => {
    try {
      const res = await fetch('/api/studio/presets');
      setPresets(await res.json());
    } catch (e: any) {
      console.error('Failed to fetch presets:', e);
    }
  }, []);

  const fetchJobs = useCallback(async () => {
    try {
      const res = await fetch('/api/studio/jobs');
      const data = await res.json();
      setActiveJobs(data.active || []);
      setJobHistory(data.history || []);
      return data.active || [];
    } catch (e: any) {
      console.error('Failed to fetch jobs:', e);
      return [];
    }
  }, []);

  const fetchStats = useCallback(async () => {
    try {
      const res = await fetch('/api/studio/stats');
      if (!res.ok) return;
      const data = await res.json();
      setStats(Array.isArray(data) ? data : []);
    } catch (e: any) {
      console.error('Failed to fetch stats:', e);
    }
  }, []);

  const fetchCoverage = useCallback(async () => {
    try {
      const res = await fetch('/api/studio/coverage');
      if (!res.ok) return;
      const data = await res.json();
      setCoverage(Array.isArray(data) ? data : []);
    } catch (e: any) {
      console.error('Failed to fetch coverage:', e);
    }
  }, []);

  useEffect(() => {
    fetchTemplates();
    fetchPresets();
    fetchStats();
    fetchCoverage();
  }, []);

  useEffect(() => {
    return () => {
      evtSourceRef.current?.close();
      if (retryTimerRef.current) clearTimeout(retryTimerRef.current);
    };
  }, []);

  const selectTemplate = (t: ProfileTemplate) => {
    setSelectedTemplate(t);
    setSelectedPreset(null);
    setEditConfig(t.defaultConfig ? JSON.parse(JSON.stringify(t.defaultConfig)) : {});
    setEditName(t.name);
    setEditRegion(t.defaultConfig?.region || 'SanFrancisco');
    setEditProfile(t.orsProfile);
  };

  const selectPreset = (p: Preset) => {
    setSelectedPreset(p);
    setSelectedTemplate(null);
    setEditConfig(p.config ? JSON.parse(JSON.stringify(p.config)) : {});
    setEditName(p.name);
    setEditRegion(p.region);
    setEditProfile(p.ors_profile);
  };

  const toggleSection = (s: string) => {
    setExpandedSections(prev => {
      const n = new Set(prev);
      n.has(s) ? n.delete(s) : n.add(s);
      return n;
    });
  };

  const updateConfig = (path: string, value: any) => {
    setEditConfig((prev: any) => {
      const next = JSON.parse(JSON.stringify(prev || {}));
      const keys = path.split('.');
      let obj = next;
      for (let i = 0; i < keys.length - 1; i++) {
        if (!obj[keys[i]]) obj[keys[i]] = {};
        obj = obj[keys[i]];
      }
      obj[keys[keys.length - 1]] = value;
      return next;
    });
  };

  const connectSSE = useCallback((jobId: string) => {
    evtSourceRef.current?.close();
    const evtSource = new EventSource(`/api/studio/jobs/${jobId}/stream`);
    evtSourceRef.current = evtSource;

    evtSource.addEventListener('progress', (e) => {
      if (!e.data) return;
      retryCountRef.current = 0;
      const data = JSON.parse(e.data);
      let msg = data.status || JSON.stringify(data);
      if (data.routeFailures > 0) msg += ` (${data.routeFailures} route failures)`;
      setLogLines(prev => [...prev.slice(-50), msg]);
      setActiveJobs(prev => prev.map(j => j.jobId === jobId ? { ...j, pointsGenerated: data.totalPoints || j.pointsGenerated, tripsGenerated: data.totalTrips || j.tripsGenerated } : j));
    });
    evtSource.addEventListener('batch', (e) => {
      if (!e.data) return;
      retryCountRef.current = 0;
      const data = JSON.parse(e.data);
      setLogLines(prev => [...prev.slice(-50), `Batch: ${data.inserted?.toLocaleString()} pts (total: ${data.total?.toLocaleString()})`]);
    });
    evtSource.addEventListener('warning', (e) => {
      if (!e.data) return;
      const data = JSON.parse(e.data);
      setLogLines(prev => [...prev.slice(-50), `WARNING: ${data.message}`]);
      console.warn('[Studio SSE warning]', data.message);
    });
    evtSource.addEventListener('complete', (e) => {
      if (!e.data) return;
      const data = JSON.parse(e.data);
      setLogLines(prev => [...prev, `Complete: ${data.pointsGenerated?.toLocaleString()} points, ${data.tripsGenerated?.toLocaleString()} trips`]);
      setGenerating(false);
      evtSource.close();
      fetchJobs(); fetchStats(); fetchCoverage();
    });
    evtSource.addEventListener('stopped', (e) => {
      if (!e.data) return;
      const d = JSON.parse(e.data);
      setLogLines(prev => [
        ...prev,
        '--- Generation Stopped ---',
        `Reason: ${d.reason}`,
        `Days completed: ${d.completedDays} / ${d.totalDays}`,
        `Points generated: ${d.pointsGenerated?.toLocaleString()}`,
        `Trips generated: ${d.tripsGenerated?.toLocaleString()}`,
        `Routes: ${d.routeSuccesses} succeeded, ${d.routeFailures} failed`,
        'Data saved. Resume ORS and re-run to complete remaining days.',
      ]);
      setGenerating(false);
      evtSource.close();
      fetchJobs(); fetchStats(); fetchCoverage();
    });
    evtSource.addEventListener('error', (e: any) => {
      evtSource.close();
      let isServerError = false;
      try {
        const errData = JSON.parse(e.data);
        setLogLines(prev => [...prev, `Error: ${errData.error}`]);
        isServerError = true;
      } catch (e: any) {
        console.error('SSE error parse failed (likely a connection drop, not a server error):', e);
      }
      if (isServerError) {
        setGenerating(false);
        fetchJobs();
        return;
      }
      if (retryCountRef.current >= 20) {
        setLogLines(prev => [...prev, 'Connection lost after 20 retries. Job may still be running server-side.']);
        setGenerating(false);
        fetchJobs();
        return;
      }
      const delay = Math.min(1000 * Math.pow(2, retryCountRef.current), 30000);
      retryCountRef.current++;
      setLogLines(prev => [...prev, `Connection lost, retrying in ${(delay / 1000).toFixed(0)}s (attempt ${retryCountRef.current}/20)...`]);
      retryTimerRef.current = setTimeout(() => connectSSE(jobId), delay);
    });
    evtSource.addEventListener('cancelled', () => {
      setLogLines(prev => [...prev, 'Job cancelled']);
      setGenerating(false);
      evtSource.close();
      fetchJobs();
    });
  }, [fetchJobs, fetchStats, fetchCoverage]);

  useEffect(() => {
    if (reconnectedRef.current) return;
    reconnectedRef.current = true;
    (async () => {
      const jobs = await fetchJobs();
      const running = jobs.find((j: any) => j.status === 'RUNNING');
      if (running) {
        setGenerating(true);
        setLogLines([
          `Reconnected to running job: ${running.jobId}`,
          `${running.presetName} | ${running.region} | ${running.orsProfile}`,
          `Progress: ${running.pointsGenerated?.toLocaleString() || 0} pts, ${running.tripsGenerated?.toLocaleString() || 0} trips`,
        ]);
        connectSSE(running.jobId);
      }
    })();
  }, [fetchJobs, connectSSE]);

  const startGeneration = async () => {
    setGenerating(true);
    setLogLines(['Starting generation...']);
    retryCountRef.current = 0;
    try {
      const body = selectedPreset
        ? { preset_id: selectedPreset.preset_id }
        : {
            config: {
              ...editConfig,
              region: editRegion,
              ors_profile: editProfile,
              vehicleType: selectedTemplate?.vehicleType || (editProfile === 'cycling-electric' ? 'ebike' : editProfile === 'driving-hgv' ? 'hgv' : 'car'),
              bbox: editRegion === 'Germany'
                ? { min_lat: 47.27, max_lat: 55.06, min_lng: 5.87, max_lng: 15.04 }
                : { min_lat: 37.7, max_lat: 37.82, min_lng: -122.52, max_lng: -122.35 },
            },
            preset_name: editName,
          };
      const res = await fetch('/api/studio/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (res.status === 409) {
        const err = await res.json();
        setLogLines(prev => [...prev, `Cannot start: ${err.error}`]);
        setGenerating(false);
        return;
      }
      if (!res.ok) {
        const err = await res.json();
        setLogLines(prev => [...prev, `Error: ${err.error || res.statusText}`]);
        setGenerating(false);
        return;
      }
      const { job_id } = await res.json();
      setLogLines(prev => [...prev, `Job started: ${job_id}`]);
      connectSSE(job_id);
      fetchJobs();
    } catch (err: any) {
      setLogLines(prev => [...prev, `Error: ${err.message}`]);
      setGenerating(false);
    }
  };

  const cancelActiveJob = async () => {
    const running = activeJobs.find(j => j.status === 'RUNNING');
    if (running) {
      await fetch(`/api/studio/jobs/${running.jobId}/cancel`, { method: 'POST' });
    }
  };

  const deleteJobData = async (jobId: string) => {
    if (!confirm(`Delete all generated data for this job? This cannot be undone.`)) return;
    setDeletingJob(jobId);
    try {
      const res = await fetch(`/api/studio/jobs/${jobId}`, { method: 'DELETE' });
      if (!res.ok) {
        const err = await res.json();
        alert(`Delete failed: ${err.error}`);
        return;
      }
      fetchJobs(); fetchStats(); fetchCoverage();
    } catch (e: any) {
      alert(`Delete failed: ${e.message}`);
    } finally {
      setDeletingJob(null);
    }
  };

  const savePreset = async () => {
    try {
      await fetch('/api/studio/presets', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: editName, ors_profile: editProfile, region: editRegion, config: editConfig }),
      });
      fetchPresets();
    } catch (e: any) {
      console.error('Failed to save preset:', e);
    }
  };

  useEffect(() => {
    if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
  }, [logLines]);

  const safeStats = Array.isArray(stats) ? stats : [];
  const totalPoints = safeStats.reduce((s: number, r: any) => s + Number(r.POINT_COUNT || 0), 0);
  const totalVehicles = safeStats.reduce((s: number, r: any) => s + Number(r.VEHICLES || 0), 0);
  const totalTrips = safeStats.reduce((s: number, r: any) => s + Number(r.TRIPS || 0), 0);
  const profileData = safeStats.map((r: any) => ({
    name: VEHICLE_LABELS[r.VEHICLE_TYPE] || r.ORS_PROFILE,
    value: Number(r.POINT_COUNT || 0),
    vehicleType: r.VEHICLE_TYPE,
  }));

  const renderField = (label: string, path: string, type: string = 'number') => {
    if (!editConfig) return null;
    const keys = path.split('.');
    let val: any = editConfig;
    for (const k of keys) { val = val?.[k]; }
    return (
      <div style={{ marginBottom: 8 }}>
        <label style={{ fontSize: 11, color: '#6E7681', display: 'block', marginBottom: 2 }}>{label}</label>
        <input
          type={type}
          value={val ?? ''}
          onChange={e => updateConfig(path, type === 'number' ? Number(e.target.value) : e.target.value)}
          style={{ width: '100%', padding: '4px 8px', borderRadius: 6, border: '1px solid #E1E4E8', fontSize: 13, background: '#FAFBFC' }}
        />
      </div>
    );
  };

  const renderSection = (key: string, title: string, content: React.ReactNode) => {
    const open = expandedSections.has(key);
    return (
      <div style={{ marginBottom: 4 }}>
        <div
          onClick={() => toggleSection(key)}
          style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '8px 0', cursor: 'pointer', borderBottom: '1px solid #E1E4E8', fontSize: 13, fontWeight: 600, color: '#24292F' }}
        >
          {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
          {title}
        </div>
        {open && <div style={{ padding: '8px 0' }}>{content}</div>}
      </div>
    );
  };

  const activeVehicleType = selectedTemplate?.vehicleType
    || (editProfile === 'cycling-electric' ? 'ebike' : editProfile === 'driving-hgv' ? 'hgv' : 'car');

  const hasAnyData = (coverage || []).some(c => c.TELEMETRY_ROWS > 0);
  const skillsReady = hasAnyData
    ? Object.keys(SKILL_MAP).reduce((acc, id) => ({ ...acc, [id]: true }), {} as Record<string, boolean>)
    : ({} as Record<string, boolean>);

  return (
    <div className="page-dashboard data-studio">
      <h2 style={{ fontSize: 20, marginBottom: 4 }}>Data Studio</h2>
      <p style={{ color: '#6E7681', fontSize: 13, marginBottom: 16 }}>Generate unified fleet telemetry and trip data for all movement-data skills</p>

      <div className="metric-grid">
        <MetricCard label="Total Points" value={totalPoints.toLocaleString()} />
        <MetricCard label="Total Trips" value={totalTrips.toLocaleString()} />
        <MetricCard label="Vehicles" value={totalVehicles} />
        <MetricCard label="Jobs Run" value={jobHistory.length} />
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr', gap: 16, marginTop: 16 }}>
        {/* Panel 1: Profile Picker */}
        <div className="chart-card" style={{ padding: 16 }}>
          <h3 style={{ fontSize: 14, marginBottom: 12 }}>Profile Templates</h3>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {templates.map(t => {
              const Icon = VEHICLE_ICONS[t.vehicleType] || Truck;
              const color = VEHICLE_COLORS[t.vehicleType] || '#6E7681';
              const isSelected = selectedTemplate?.id === t.id;
              return (
                <div
                  key={t.id}
                  onClick={() => selectTemplate(t)}
                  style={{
                    padding: 12, borderRadius: 8, cursor: 'pointer',
                    border: isSelected ? `2px solid ${color}` : '1px solid #E1E4E8',
                    background: isSelected ? `${color}08` : '#FAFBFC',
                    transition: 'all 0.15s ease',
                  }}
                >
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
                    <Icon size={18} color={color} />
                    <span style={{ fontSize: 13, fontWeight: 600, color: '#24292F' }}>{t.name}</span>
                  </div>
                  <div style={{ fontSize: 11, color: '#6E7681', marginBottom: 6 }}>{t.description}</div>
                  <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
                    <span style={{ fontSize: 10, padding: '1px 6px', borderRadius: 10, background: `${color}18`, color, fontWeight: 500 }}>
                      {t.vehicleType}
                    </span>
                    <span style={{ fontSize: 10, padding: '1px 6px', borderRadius: 10, background: '#F0F0F0', color: '#6E7681' }}>
                      {t.regionScale}
                    </span>
                    {t.feeds.map(f => (
                      <span key={f} style={{ fontSize: 10, padding: '1px 6px', borderRadius: 10, background: skillsReady[f] ? '#E6F9ED' : '#FFF8E6', color: skillsReady[f] ? '#1B7A3D' : '#9D6B00' }}>
                        {SKILL_MAP[f] || f}
                      </span>
                    ))}
                  </div>
                </div>
              );
            })}
          </div>

          {presets.length > 0 && (
            <>
              <h4 style={{ fontSize: 12, marginTop: 16, marginBottom: 8, color: '#6E7681' }}>Saved Presets</h4>
              {presets.filter(p => !p.is_builtin).map(p => (
                <div
                  key={p.preset_id}
                  onClick={() => selectPreset(p)}
                  style={{
                    padding: '8px 10px', marginBottom: 4, borderRadius: 6, cursor: 'pointer', fontSize: 12,
                    border: selectedPreset?.preset_id === p.preset_id ? '2px solid #29B5E8' : '1px solid #E1E4E8',
                    background: selectedPreset?.preset_id === p.preset_id ? '#F0F9FF' : '#FAFBFC',
                  }}
                >
                  <div style={{ fontWeight: 500 }}>{p.name}</div>
                  <div style={{ fontSize: 10, color: '#6E7681' }}>{p.region} | {p.ors_profile}</div>
                </div>
              ))}
            </>
          )}
        </div>

        {/* Panel 2: Configuration Editor */}
        <div className="chart-card" style={{ padding: 16 }}>
          {!editConfig ? (
            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', height: '100%', color: '#9CA3AF' }}>
              <Database size={40} strokeWidth={1.2} />
              <p style={{ fontSize: 14, marginTop: 12 }}>Select a profile to configure</p>
            </div>
          ) : (
            <>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
                <h3 style={{ fontSize: 14, margin: 0 }}>Configuration</h3>
                {(() => {
                  const Icon = VEHICLE_ICONS[activeVehicleType] || Truck;
                  const color = VEHICLE_COLORS[activeVehicleType] || '#6E7681';
                  return <span style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 11, color, fontWeight: 600 }}><Icon size={14} />{VEHICLE_LABELS[activeVehicleType]}</span>;
                })()}
              </div>

              <div style={{ marginBottom: 12 }}>
                <label style={{ fontSize: 11, color: '#6E7681' }}>Preset Name</label>
                <input value={editName} onChange={e => setEditName(e.target.value)} style={{ width: '100%', padding: '4px 8px', borderRadius: 6, border: '1px solid #E1E4E8', fontSize: 13 }} />
              </div>

              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, marginBottom: 12 }}>
                <div>
                  <label style={{ fontSize: 11, color: '#6E7681' }}>Region</label>
                  <select value={editRegion} onChange={e => setEditRegion(e.target.value)} style={{ width: '100%', padding: '4px 8px', borderRadius: 6, border: '1px solid #E1E4E8', fontSize: 13 }}>
                    <option value="SanFrancisco">San Francisco</option>
                    <option value="Berlin">Berlin</option>
                    <option value="Germany">Germany</option>
                    <option value="London">London</option>
                  </select>
                </div>
                <div>
                  <label style={{ fontSize: 11, color: '#6E7681' }}>ORS Profile</label>
                  <select value={editProfile} onChange={e => setEditProfile(e.target.value)} style={{ width: '100%', padding: '4px 8px', borderRadius: 6, border: '1px solid #E1E4E8', fontSize: 13 }}>
                    <option value="driving-car">driving-car</option>
                    <option value="cycling-electric">cycling-electric</option>
                    <option value="driving-hgv">driving-hgv</option>
                  </select>
                </div>
              </div>

              {renderSection('time', 'Time Range', (
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
                  {renderField('Start Date', 'time.start_date', 'date')}
                  {renderField('End Date', 'time.end_date', 'date')}
                </div>
              ))}

              {renderSection('fleet', 'Fleet', (
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
                  {renderField('Vehicles', 'fleet.num_vehicles')}
                  {renderField('Trips/Day Min', 'fleet.trips_per_day.min')}
                  {renderField('Trips/Day Max', 'fleet.trips_per_day.max')}
                  {renderField('Weekday Op Rate', 'fleet.weekday_operating_rate')}
                </div>
              ))}

              {renderSection('distance', 'Distance Distribution', (
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
                  {renderField('Short %', 'distance_distribution.short_pct')}
                  {renderField('Short Max km', 'distance_distribution.short_max_km')}
                  {renderField('Medium %', 'distance_distribution.medium_pct')}
                  {renderField('Medium Max km', 'distance_distribution.medium_max_km')}
                </div>
              ))}

              {renderSection('dwell', 'Dwell Times', (
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 8 }}>
                  {renderField('Origin Median (min)', 'dwell.origin.median_min')}
                  {renderField('Origin Sigma', 'dwell.origin.sigma')}
                  {renderField('Origin Max (min)', 'dwell.origin.max_min')}
                  {renderField('Dest Median (min)', 'dwell.destination.median_min')}
                  {renderField('Dest Sigma', 'dwell.destination.sigma')}
                  {renderField('Dest Max (min)', 'dwell.destination.max_min')}
                </div>
              ))}

              {renderSection('routing', 'Routing & Detours', (
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
                  {renderField('Optimal Route %', 'routing.optimal_route_probability')}
                  {renderField('Alt Route %', 'routing.alternative_route_probability')}
                  {renderField('Detour Probability', 'detour.probability')}
                  {renderField('Max Detour Factor', 'detour.max_detour_factor')}
                  {renderField('Default Speed', 'routing.posted_speeds.default')}
                </div>
              ))}

              {renderSection('telemetry', 'Telemetry', (
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
                  {renderField('Ping Mean (sec)', 'telemetry.ping_interval_moving.mean_sec')}
                  {renderField('Ping Std (sec)', 'telemetry.ping_interval_moving.std_sec')}
                  {renderField('GPS Jitter (m)', 'telemetry.gps_jitter.typical_m')}
                  {renderField('Multipath Prob', 'telemetry.gps_jitter.multipath_probability')}
                </div>
              ))}

              {activeVehicleType === 'hgv' && renderSection('breaks', 'HOS / Breaks', (
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
                  {renderField('Hours Between Breaks', 'breaks.driving_hours_between_breaks')}
                  {renderField('Break Duration (min)', 'breaks.mandatory_break_duration_min')}
                  {renderField('Max Daily Driving (h)', 'breaks.max_daily_driving_hours')}
                </div>
              ))}

              {activeVehicleType === 'ebike' && renderSection('battery', 'Battery', (
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
                  {renderField('Range (km)', 'battery.range_km')}
                  {renderField('Drain/km (%)', 'battery.drain_per_km')}
                  {renderField('Recharge Threshold (%)', 'battery.recharge_threshold_pct')}
                </div>
              ))}

              {activeVehicleType === 'ebike' && renderSection('sla', 'Delivery SLA', (
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
                  {renderField('Target (min)', 'delivery_sla.target_minutes')}
                  {renderField('Warning (min)', 'delivery_sla.warning_minutes')}
                </div>
              ))}

              <div style={{ display: 'flex', gap: 8, marginTop: 16 }}>
                <button onClick={startGeneration} disabled={generating} className="btn-primary" style={{ flex: 1, fontSize: 13, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6 }}>
                  {generating ? <><Clock size={14} className="spin" /> Generating...</> : <><Play size={14} /> Generate</>}
                </button>
                {generating && (
                  <button onClick={cancelActiveJob} className="btn-secondary" style={{ fontSize: 12, display: 'flex', alignItems: 'center', gap: 4 }}>
                    <Square size={12} /> Stop
                  </button>
                )}
                {!selectedPreset?.is_builtin && (
                  <button onClick={savePreset} className="btn-secondary" style={{ fontSize: 12, display: 'flex', alignItems: 'center', gap: 4 }}>
                    <Save size={12} /> Save
                  </button>
                )}
              </div>
            </>
          )}
        </div>

        {/* Panel 3: Generation Dashboard */}
        <div className="chart-card" style={{ padding: 16 }}>
          <h3 style={{ fontSize: 14, marginBottom: 12 }}>Generation Status</h3>

          {activeJobs.filter(j => j.status === 'RUNNING').map(j => (
            <div key={j.jobId} style={{ marginBottom: 12, padding: 10, borderRadius: 6, border: `1px solid ${VEHICLE_COLORS[j.vehicleType] || '#29B5E8'}`, background: `${VEHICLE_COLORS[j.vehicleType] || '#29B5E8'}08` }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <span style={{ fontSize: 12, fontWeight: 600 }}>{j.presetName}</span>
                <span style={{ fontSize: 10, padding: '1px 6px', borderRadius: 10, background: '#E6F0FF', color: '#1A73E8' }}>Running</span>
              </div>
              <div style={{ fontSize: 11, color: '#6E7681', marginTop: 4 }}>{j.region} | {j.orsProfile}</div>
              <div style={{ display: 'flex', gap: 12, marginTop: 6, fontSize: 12 }}>
                <span style={{ fontWeight: 600, color: VEHICLE_COLORS[j.vehicleType] || '#29B5E8' }}>{j.pointsGenerated?.toLocaleString() || 0} pts</span>
                <span style={{ color: '#6E7681' }}>{j.tripsGenerated?.toLocaleString() || 0} trips</span>
              </div>
            </div>
          ))}

          <div ref={logRef} style={{ background: '#1B1F23', color: '#8DC891', borderRadius: 6, padding: 10, fontFamily: 'monospace', fontSize: 11, height: 160, overflowY: 'auto', marginBottom: 12 }}>
            {logLines.length === 0 ? <span style={{ color: '#6E7681' }}>No active generation</span> : logLines.map((line, i) => <div key={i}>{line}</div>)}
          </div>

          <h4 style={{ fontSize: 12, marginBottom: 8 }}>Skills Coverage</h4>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginBottom: 12 }}>
            {Object.entries(SKILL_MAP).map(([skillId, skillName]) => {
              const ready = skillsReady[skillId];
              const totalTelemetry = (coverage || []).reduce((s, c) => s + (c.TELEMETRY_ROWS || 0), 0);
              const totalTripsC = (coverage || []).reduce((s, c) => s + (c.TRIP_ROWS || 0), 0);
              const totalVehiclesC = (coverage || []).reduce((s, c) => s + (c.VEHICLES || 0), 0);
              return (
                <div key={skillId} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 8px', borderRadius: 6, background: ready ? '#F6FFF8' : '#FAFBFC', border: `1px solid ${ready ? '#C8E6C9' : '#E1E4E8'}` }}>
                  {ready ? <CheckCircle size={14} color="#4CAF50" /> : <AlertCircle size={14} color="#9CA3AF" />}
                  <div style={{ flex: 1 }}>
                    <div style={{ fontSize: 12, fontWeight: 500, color: '#24292F' }}>{skillName}</div>
                    {ready ? (
                      <div style={{ fontSize: 10, color: '#6E7681' }}>
                        {totalTelemetry.toLocaleString()} pts | {totalTripsC.toLocaleString()} trips | {totalVehiclesC} vehicles
                      </div>
                    ) : (
                      <div style={{ fontSize: 10, color: '#9CA3AF' }}>No data generated</div>
                    )}
                  </div>
                  <span style={{ width: 8, height: 8, borderRadius: 4, background: ready ? '#4CAF50' : '#E1E4E8' }} />
                </div>
              );
            })}
          </div>

          {profileData.length > 0 && (
            <>
              <h4 style={{ fontSize: 12, marginBottom: 6 }}>Data Distribution</h4>
              <ResponsiveContainer width="100%" height={120}>
                <PieChart>
                  <Pie data={profileData} dataKey="value" nameKey="name" cx="50%" cy="50%" outerRadius={48} label={({ name }) => name} labelLine={{ stroke: '#ccc' }}>
                    {profileData.map((d, i) => <Cell key={i} fill={VEHICLE_COLORS[d.vehicleType] || PIE_COLORS[i % PIE_COLORS.length]} />)}
                  </Pie>
                  <Tooltip />
                </PieChart>
              </ResponsiveContainer>
            </>
          )}
        </div>
      </div>

      {jobHistory.length > 0 && (
        <div className="chart-card" style={{ marginTop: 16, padding: 16 }}>
          <h3 style={{ fontSize: 14, marginBottom: 12 }}>Job History</h3>
          <div className="data-table-container">
            <table className="data-table">
              <thead>
                <tr>
                  <th className="data-table-th">Preset</th>
                  <th className="data-table-th">Region</th>
                  <th className="data-table-th">Profile</th>
                  <th className="data-table-th">Vehicles</th>
                  <th className="data-table-th">Status</th>
                  <th className="data-table-th">Points</th>
                  <th className="data-table-th">Trips</th>
                  <th className="data-table-th">Duration</th>
                  <th className="data-table-th">Started</th>
                  <th className="data-table-th">Details</th>
                  <th className="data-table-th"></th>
                </tr>
              </thead>
              <tbody>
                {jobHistory.map((j: any, i: number) => {
                  const status = j.STATUS || '';
                  const statusColor = status === 'COMPLETED' ? '#1B7A3D' : status === 'FAILED' ? '#D32F2F' : status === 'STOPPED' ? '#E65100' : status === 'CANCELLED' ? '#6E7681' : status === 'RUNNING' ? '#1A73E8' : '#6E7681';
                  const statusBg = status === 'COMPLETED' ? '#E6F9ED' : status === 'FAILED' ? '#FFEBEE' : status === 'STOPPED' ? '#FFF3E0' : status === 'CANCELLED' ? '#F5F5F5' : status === 'RUNNING' ? '#E6F0FF' : '#F5F5F5';
                  const dur = j.DURATION_SEC;
                  const durStr = dur != null ? (dur >= 3600 ? `${Math.floor(dur / 3600)}h ${Math.floor((dur % 3600) / 60)}m` : dur >= 60 ? `${Math.floor(dur / 60)}m ${dur % 60}s` : `${dur}s`) : '-';
                  const started = j.STARTED_AT ? new Date(j.STARTED_AT).toLocaleString() : '-';
                  return (
                    <tr key={j.JOB_ID || i}>
                      <td style={{ fontWeight: 500, fontSize: 12 }}>{j.PRESET_NAME || '-'}</td>
                      <td style={{ fontSize: 12 }}>{j.REGION || '-'}</td>
                      <td style={{ fontSize: 12 }}>{j.ORS_PROFILE || '-'}</td>
                      <td style={{ fontSize: 12, textAlign: 'right' }}>{j.NUM_VEHICLES ?? '-'}</td>
                      <td>
                        <span style={{ fontSize: 10, padding: '2px 8px', borderRadius: 10, background: statusBg, color: statusColor, fontWeight: 600, whiteSpace: 'nowrap' }}>
                          {status}
                        </span>
                      </td>
                      <td style={{ fontSize: 12, textAlign: 'right', fontWeight: 500 }}>{j.POINTS_GENERATED?.toLocaleString() || '0'}</td>
                      <td style={{ fontSize: 12, textAlign: 'right' }}>{j.TRIPS_GENERATED?.toLocaleString() || '0'}</td>
                      <td style={{ fontSize: 12, textAlign: 'right', color: '#6E7681' }}>{durStr}</td>
                      <td style={{ fontSize: 11, color: '#6E7681', whiteSpace: 'nowrap' }}>{started}</td>
                      <td style={{ fontSize: 11, maxWidth: 200 }}>
                        {j.ERROR_MESSAGE ? (
                          <span title={j.ERROR_MESSAGE} style={{ color: '#D32F2F', cursor: 'help', display: 'block', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 200 }}>
                            {j.ERROR_MESSAGE}
                          </span>
                        ) : (
                          <span style={{ color: '#9CA3AF' }}>-</span>
                        )}
                      </td>
                      <td style={{ textAlign: 'center' }}>
                        {status !== 'RUNNING' && status !== 'DELETED' && (
                          <button
                            onClick={() => deleteJobData(j.JOB_ID)}
                            disabled={deletingJob === j.JOB_ID}
                            title="Delete generated data for this job"
                            style={{ background: 'none', border: 'none', cursor: deletingJob === j.JOB_ID ? 'wait' : 'pointer', padding: 4, borderRadius: 4, opacity: deletingJob === j.JOB_ID ? 0.4 : 0.6 }}
                          >
                            <Trash2 size={14} color="#D32F2F" />
                          </button>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}

import { useState, useEffect, useCallback, useRef } from 'react';
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, PieChart, Pie, Cell } from 'recharts';
import MetricCard from '../../shared/MetricCard';
import DataTable from '../../shared/DataTable';

interface Preset {
  preset_id: string;
  name: string;
  ors_profile: string;
  region: string;
  config: any;
  is_builtin: boolean;
}

interface JobInfo {
  jobId: string;
  presetName: string;
  region: string;
  orsProfile: string;
  status: string;
  pointsGenerated: number;
  tripsGenerated: number;
  startedAt: string;
}

const PROFILE_LABELS: Record<string, string> = {
  'driving-car': 'Taxi / Rideshare',
  'cycling-electric': 'E-Bike Delivery',
  'driving-hgv': 'HGV Trucking',
};

const PROFILE_COLORS: Record<string, string> = {
  'driving-car': '#29B5E8',
  'cycling-electric': '#4CAF50',
  'driving-hgv': '#FF9800',
};

const PIE_COLORS = ['#29B5E8', '#4CAF50', '#FF9800', '#E91E63', '#9C27B0'];

export default function FleetDataStudio() {
  const [presets, setPresets] = useState<Preset[]>([]);
  const [selectedPreset, setSelectedPreset] = useState<Preset | null>(null);
  const [editConfig, setEditConfig] = useState<any>(null);
  const [editName, setEditName] = useState('');
  const [editRegion, setEditRegion] = useState('SanFrancisco');
  const [editProfile, setEditProfile] = useState('driving-car');
  const [activeJobs, setActiveJobs] = useState<JobInfo[]>([]);
  const [jobHistory, setJobHistory] = useState<any[]>([]);
  const [generating, setGenerating] = useState(false);
  const [logLines, setLogLines] = useState<string[]>([]);
  const [stats, setStats] = useState<any[]>([]);
  const [expandedSections, setExpandedSections] = useState<Set<string>>(new Set(['fleet', 'time', 'dwell']));
  const logRef = useRef<HTMLDivElement>(null);

  const fetchPresets = useCallback(async () => {
    try {
      const res = await fetch('/api/studio/presets');
      const data = await res.json();
      setPresets(data);
    } catch {}
  }, []);

  const fetchJobs = useCallback(async () => {
    try {
      const res = await fetch('/api/studio/jobs');
      const data = await res.json();
      setActiveJobs(data.active || []);
      setJobHistory(data.history || []);
    } catch {}
  }, []);

  const fetchStats = useCallback(async () => {
    try {
      const res = await fetch('/api/studio/stats');
      setStats(await res.json());
    } catch {}
  }, []);

  useEffect(() => { fetchPresets(); fetchJobs(); fetchStats(); }, []);

  const selectPreset = (p: Preset) => {
    setSelectedPreset(p);
    setEditConfig(JSON.parse(JSON.stringify(p.config)));
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
      const next = JSON.parse(JSON.stringify(prev));
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

  const startGeneration = async () => {
    setGenerating(true);
    setLogLines(['Starting generation...']);
    try {
      const body = selectedPreset
        ? { preset_id: selectedPreset.preset_id }
        : { config: { ...editConfig, region: editRegion, ors_profile: editProfile, bbox: { min_lat: 37.7, max_lat: 37.82, min_lng: -122.52, max_lng: -122.35 } }, preset_name: editName };
      const res = await fetch('/api/studio/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const { job_id } = await res.json();
      setLogLines(prev => [...prev, `Job started: ${job_id}`]);

      const evtSource = new EventSource(`/api/studio/jobs/${job_id}/stream`);
      evtSource.addEventListener('progress', (e) => {
        const data = JSON.parse(e.data);
        setLogLines(prev => [...prev.slice(-50), data.status || JSON.stringify(data)]);
        setActiveJobs(prev => prev.map(j => j.jobId === job_id ? { ...j, pointsGenerated: data.totalPoints || j.pointsGenerated, tripsGenerated: data.totalTrips || j.tripsGenerated } : j));
      });
      evtSource.addEventListener('batch', (e) => {
        const data = JSON.parse(e.data);
        setLogLines(prev => [...prev.slice(-50), `Inserted batch: ${data.inserted?.toLocaleString()} points (total: ${data.total?.toLocaleString()})`]);
      });
      evtSource.addEventListener('complete', (e) => {
        const data = JSON.parse(e.data);
        setLogLines(prev => [...prev, `Generation complete! ${data.pointsGenerated?.toLocaleString()} points, ${data.tripsGenerated?.toLocaleString()} trips`]);
        setGenerating(false);
        evtSource.close();
        fetchJobs();
        fetchStats();
      });
      evtSource.addEventListener('error', (e: any) => {
        try {
          const data = JSON.parse(e.data);
          setLogLines(prev => [...prev, `Error: ${data.error}`]);
        } catch {
          setLogLines(prev => [...prev, 'Connection lost']);
        }
        setGenerating(false);
        evtSource.close();
        fetchJobs();
      });
      evtSource.addEventListener('cancelled', () => {
        setLogLines(prev => [...prev, 'Job cancelled']);
        setGenerating(false);
        evtSource.close();
        fetchJobs();
      });

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

  const savePreset = async () => {
    try {
      await fetch('/api/studio/presets', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: editName, ors_profile: editProfile, region: editRegion, config: editConfig }),
      });
      fetchPresets();
    } catch {}
  };

  useEffect(() => {
    if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
  }, [logLines]);

  const totalPoints = stats.reduce((s: number, r: any) => s + Number(r.POINT_COUNT || 0), 0);
  const totalVehicles = stats.reduce((s: number, r: any) => s + Number(r.VEHICLES || 0), 0);
  const profileData = stats.map((r: any) => ({ name: PROFILE_LABELS[r.ORS_PROFILE] || r.ORS_PROFILE, value: Number(r.POINT_COUNT || 0), profile: r.ORS_PROFILE }));

  const renderField = (label: string, path: string, type: string = 'number') => {
    if (!editConfig) return null;
    const keys = path.split('.');
    let val: any = editConfig;
    for (const k of keys) { val = val?.[k]; }
    return (
      <div className="form-group" style={{ marginBottom: 8 }}>
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

  const renderSection = (key: string, title: string, content: React.ReactNode) => (
    <div style={{ marginBottom: 8 }}>
      <div
        onClick={() => toggleSection(key)}
        style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '8px 0', cursor: 'pointer', borderBottom: '1px solid #E1E4E8', fontSize: 13, fontWeight: 600, color: '#24292F' }}
      >
        {title}
        <span style={{ fontSize: 10 }}>{expandedSections.has(key) ? '▼' : '▶'}</span>
      </div>
      {expandedSections.has(key) && <div style={{ padding: '8px 0' }}>{content}</div>}
    </div>
  );

  return (
    <div className="page-dashboard data-studio">
      <h2 style={{ fontSize: 20, marginBottom: 4 }}>Data Studio</h2>
      <p style={{ color: '#6E7681', fontSize: 13, marginBottom: 16 }}>Generate unified vehicle telemetry for all movement-data skills</p>

      <div className="metric-grid">
        <MetricCard label="Total Points" value={totalPoints.toLocaleString()} />
        <MetricCard label="Vehicles" value={totalVehicles} />
        <MetricCard label="Profiles" value={stats.length} />
        <MetricCard label="Jobs Run" value={jobHistory.length} />
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '240px 1fr 320px', gap: 16, marginTop: 16 }}>
        {/* Panel 1: Presets */}
        <div className="chart-card" style={{ padding: 16 }}>
          <h3 style={{ fontSize: 14, marginBottom: 12 }}>Preset Library</h3>
          {['driving-car', 'cycling-electric', 'driving-hgv'].map(profile => {
            const builtIn = presets.filter(p => p.ors_profile === profile && p.is_builtin);
            const custom = presets.filter(p => p.ors_profile === profile && !p.is_builtin);
            return (
              <div key={profile} style={{ marginBottom: 12 }}>
                <div style={{ fontSize: 11, fontWeight: 600, color: PROFILE_COLORS[profile], marginBottom: 4, textTransform: 'uppercase', letterSpacing: '0.5px' }}>
                  {PROFILE_LABELS[profile] || profile}
                </div>
                {[...builtIn, ...custom].map(p => (
                  <div
                    key={p.preset_id}
                    onClick={() => selectPreset(p)}
                    style={{
                      padding: '8px 10px', marginBottom: 4, borderRadius: 6, cursor: 'pointer', fontSize: 12,
                      border: selectedPreset?.preset_id === p.preset_id ? `2px solid ${PROFILE_COLORS[profile]}` : '1px solid #E1E4E8',
                      background: selectedPreset?.preset_id === p.preset_id ? '#F0F9FF' : '#FAFBFC',
                    }}
                  >
                    <div style={{ fontWeight: 500 }}>{p.name}</div>
                    <div style={{ fontSize: 10, color: '#6E7681' }}>{p.region} | {p.config?.fleet?.num_vehicles || '?'} vehicles</div>
                  </div>
                ))}
              </div>
            );
          })}
          <button onClick={() => { setSelectedPreset(null); setEditConfig({ mode: 'urban_mobility', fleet: { num_vehicles: 50, trips_per_day: { min: 5, max: 15 } }, shifts: [{ name: 'Day', start: 8, end: 18, proportion: 1 }], time: { start_date: '2026-03-01', end_date: '2026-03-07', chunk_size_days: 7 }, distance_distribution: { short_pct: 0.6, short_max_km: 5, medium_pct: 0.3, medium_max_km: 15, long_pct: 0.1 }, driver_profiles: { COMPLIANT: { proportion: 0.85, detour_probability: 0.05, speeding_probability: 0.03, speed_variance: 0.06 }, MILD: { proportion: 0.12, detour_probability: 0.15, speeding_probability: 0.10, speed_variance: 0.10 }, OUTLIER: { proportion: 0.03, detour_probability: 0.30, speeding_probability: 0.20, speed_variance: 0.15 } }, routing: { optimal_route_probability: 0.80, alternative_route_probability: 0.15, detour_probability: 0.05, posted_speeds: { primary: 40, secondary: 35, residential: 25, default: 30 } }, telemetry: { ping_interval_moving: { mean_sec: 15, std_sec: 5 }, ping_interval_dwell: { min_sec: 60, max_sec: 180 }, gps_jitter: { typical_m: 8, multipath_probability: 0.02, multipath_max_m: 100 } }, dwell: { origin: { median_min: 5, sigma: 0.6, max_min: 20 }, destination: { median_min: 3, sigma: 0.5, max_min: 15 }, idle: { median_min: 8, sigma: 0.6, max_min: 30 } } }); setEditName('New Preset'); }} className="btn-primary" style={{ width: '100%', marginTop: 8, fontSize: 12 }}>
            + New Preset
          </button>
        </div>

        {/* Panel 2: Parameter Editor */}
        <div className="chart-card" style={{ padding: 16, overflowY: 'auto', maxHeight: 600 }}>
          <h3 style={{ fontSize: 14, marginBottom: 12 }}>Parameter Editor</h3>
          {!editConfig ? (
            <p style={{ color: '#9CA3AF', fontSize: 13 }}>Select a preset or create new</p>
          ) : (
            <>
              <div className="form-group" style={{ marginBottom: 12 }}>
                <label style={{ fontSize: 11, color: '#6E7681' }}>Preset Name</label>
                <input value={editName} onChange={e => setEditName(e.target.value)} style={{ width: '100%', padding: '4px 8px', borderRadius: 6, border: '1px solid #E1E4E8', fontSize: 13 }} />
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, marginBottom: 12 }}>
                <div className="form-group">
                  <label style={{ fontSize: 11, color: '#6E7681' }}>Region</label>
                  <select value={editRegion} onChange={e => setEditRegion(e.target.value)} style={{ width: '100%', padding: '4px 8px', borderRadius: 6, border: '1px solid #E1E4E8', fontSize: 13 }}>
                    <option value="SanFrancisco">San Francisco</option>
                    <option value="Germany">Germany</option>
                  </select>
                </div>
                <div className="form-group">
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

              {renderSection('telemetry', 'Telemetry', (
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
                  {renderField('Ping Mean (sec)', 'telemetry.ping_interval_moving.mean_sec')}
                  {renderField('Ping Std (sec)', 'telemetry.ping_interval_moving.std_sec')}
                  {renderField('GPS Jitter (m)', 'telemetry.gps_jitter.typical_m')}
                  {renderField('Multipath Prob', 'telemetry.gps_jitter.multipath_probability')}
                </div>
              ))}

              {renderSection('routing', 'Routing', (
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
                  {renderField('Optimal Route %', 'routing.optimal_route_probability')}
                  {renderField('Alt Route %', 'routing.alternative_route_probability')}
                  {renderField('Detour %', 'routing.detour_probability')}
                  {renderField('Default Speed', 'routing.posted_speeds.default')}
                </div>
              ))}

              {editProfile === 'driving-hgv' && renderSection('breaks', 'HOS / Breaks', (
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
                  {renderField('Hours Between Breaks', 'breaks.driving_hours_between_breaks')}
                  {renderField('Break Duration (min)', 'breaks.mandatory_break_duration_min')}
                  {renderField('Max Daily Driving (h)', 'breaks.max_daily_driving_hours')}
                </div>
              ))}

              {editProfile === 'cycling-electric' && renderSection('battery', 'Battery', (
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
                  {renderField('Range (km)', 'battery.range_km')}
                  {renderField('Drain/km', 'battery.drain_per_km')}
                  {renderField('Recharge Threshold %', 'battery.recharge_threshold_pct')}
                </div>
              ))}

              <div style={{ display: 'flex', gap: 8, marginTop: 16 }}>
                <button onClick={startGeneration} disabled={generating} className="btn-primary" style={{ flex: 1, fontSize: 13 }}>
                  {generating ? 'Generating...' : 'Generate'}
                </button>
                {!selectedPreset?.is_builtin && (
                  <button onClick={savePreset} className="btn-secondary" style={{ fontSize: 12 }}>Save Preset</button>
                )}
              </div>
            </>
          )}
        </div>

        {/* Panel 3: Status */}
        <div className="chart-card" style={{ padding: 16 }}>
          <h3 style={{ fontSize: 14, marginBottom: 12 }}>Generation Status</h3>

          {activeJobs.filter(j => j.status === 'RUNNING').map(j => (
            <div key={j.jobId} style={{ marginBottom: 12, padding: 10, borderRadius: 6, border: '1px solid #29B5E8', background: '#F0F9FF' }}>
              <div style={{ fontSize: 12, fontWeight: 600 }}>{j.presetName}</div>
              <div style={{ fontSize: 11, color: '#6E7681', marginTop: 4 }}>{j.region} | {j.orsProfile}</div>
              <div style={{ fontSize: 13, fontWeight: 600, color: '#29B5E8', marginTop: 4 }}>{j.pointsGenerated?.toLocaleString() || 0} pts</div>
              <button onClick={cancelActiveJob} style={{ marginTop: 8, fontSize: 11, padding: '3px 10px', borderRadius: 4, border: '1px solid #E91E63', color: '#E91E63', background: 'white', cursor: 'pointer' }}>Cancel</button>
            </div>
          ))}

          <div ref={logRef} style={{ background: '#1B1F23', color: '#8DC891', borderRadius: 6, padding: 10, fontFamily: 'monospace', fontSize: 11, height: 200, overflowY: 'auto', marginBottom: 12 }}>
            {logLines.length === 0 ? <span style={{ color: '#6E7681' }}>No active generation</span> : logLines.map((line, i) => <div key={i}>{line}</div>)}
          </div>

          {profileData.length > 0 && (
            <>
              <h4 style={{ fontSize: 12, marginBottom: 8 }}>Data by Profile</h4>
              <ResponsiveContainer width="100%" height={140}>
                <PieChart>
                  <Pie data={profileData} dataKey="value" nameKey="name" cx="50%" cy="50%" outerRadius={55} label={({ name }) => name} labelLine={{ stroke: '#ccc' }}>
                    {profileData.map((_, i) => <Cell key={i} fill={PIE_COLORS[i % PIE_COLORS.length]} />)}
                  </Pie>
                  <Tooltip />
                </PieChart>
              </ResponsiveContainer>
            </>
          )}
        </div>
      </div>

      {/* Job History */}
      {jobHistory.length > 0 && (
        <div className="chart-card" style={{ marginTop: 16 }}>
          <h3>Job History</h3>
          <DataTable data={jobHistory} columns={['PRESET_NAME', 'REGION', 'ORS_PROFILE', 'STATUS', 'POINTS_GENERATED', 'TRIPS_GENERATED', 'STARTED_AT']} />
        </div>
      )}
    </div>
  );
}

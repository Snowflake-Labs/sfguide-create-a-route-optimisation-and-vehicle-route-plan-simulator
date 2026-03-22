import { useState, useCallback, useEffect, useRef } from 'react';
import { CITY_CATALOG } from '../types';

interface CityStatus {
  region: string;
  display_name?: string;
  status: string;
  serviceStatus: string;
  pbfDownloaded: boolean;
  functionExists: boolean;
  isDefault?: boolean;
}

interface ProvisionJob {
  job_id: string;
  region: string;
  display_name: string;
  profiles: string;
  status: string;
  stage: string;
  message: string;
  error_msg: string;
  statement_handle: string;
  created_at: string;
  started_at: string;
  completed_at: string;
}

const PROVISION_PHASES = [
  { id: 'downloading', label: 'Download Map Data' },
  { id: 'configuring', label: 'Write ORS Config' },
  { id: 'starting_service', label: 'Create ORS Service' },
  { id: 'waiting_for_service', label: 'Wait for Service' },
  { id: 'building_graph', label: 'Build Routing Graph' },
];

const PHASE_ORDER = ['not_started', 'downloading', 'configuring', 'starting_service', 'waiting_for_service', 'building_graph', 'ready'];

const ALL_PROFILES: { id: string; label: string; group: string }[] = [
  { id: 'driving-car', label: 'Car', group: 'Driving' },
  { id: 'driving-hgv', label: 'Truck (HGV)', group: 'Driving' },
  { id: 'cycling-regular', label: 'Cycling', group: 'Cycling' },
  { id: 'cycling-road', label: 'Cycling (Road)', group: 'Cycling' },
  { id: 'cycling-mountain', label: 'Cycling (Mountain)', group: 'Cycling' },
  { id: 'cycling-electric', label: 'E-Bike', group: 'Cycling' },
  { id: 'foot-walking', label: 'Walking', group: 'Foot' },
  { id: 'foot-hiking', label: 'Hiking', group: 'Foot' },
  { id: 'wheelchair', label: 'Wheelchair', group: 'Accessibility' },
];

const DEFAULT_PROFILES = ['driving-car', 'driving-hgv', 'cycling-electric'];

export default function CityProvisioner() {
  const [cities, setCities] = useState<CityStatus[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedCity, setSelectedCity] = useState('');
  const [selectedProfiles, setSelectedProfiles] = useState<string[]>(DEFAULT_PROFILES);
  const [provisionJobs, setProvisionJobs] = useState<ProvisionJob[]>([]);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const fetchCities = useCallback(async () => {
    try {
      const r = await fetch('/api/cities');
      const data = await r.json();
      setCities(data.cities || []);
    } catch {}
    setLoading(false);
  }, []);

  const fetchProvisionJobs = useCallback(async () => {
    try {
      const r = await fetch('/api/cities/provision/status');
      const data = await r.json();
      setProvisionJobs(data.jobs || []);
    } catch {}
  }, []);

  const hasActiveJobs = provisionJobs.some((j) => j.status === 'RUNNING' || j.status === 'PENDING');

  useEffect(() => {
    fetchCities();
    fetchProvisionJobs();
  }, [fetchCities, fetchProvisionJobs]);

  useEffect(() => {
    if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; }
    if (!hasActiveJobs) return;
    pollRef.current = setInterval(() => {
      fetchProvisionJobs();
      fetchCities();
    }, 3000);
    return () => { if (pollRef.current) clearInterval(pollRef.current); };
  }, [hasActiveJobs, fetchProvisionJobs, fetchCities]);

  const toggleProfile = useCallback((profileId: string) => {
    setSelectedProfiles((prev) =>
      prev.includes(profileId) ? prev.filter((p) => p !== profileId) : [...prev, profileId]
    );
  }, []);

  const isRegionProvisioning = useCallback((region: string) => {
    return provisionJobs.some((j) => j.region.toUpperCase() === region.toUpperCase() && (j.status === 'RUNNING' || j.status === 'PENDING'));
  }, [provisionJobs]);

  const startProvision = useCallback(async () => {
    if (!selectedCity) return;
    const config = CITY_CATALOG[selectedCity];
    if (!config) return;
    if (selectedProfiles.length === 0) return;

    try {
      const resp = await fetch('/api/cities/provision', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          city: selectedCity,
          region: config.region,
          pbf_url: config.pbfUrl,
          bbox: config.bbox,
          profiles: selectedProfiles,
        }),
      });
      const data = await resp.json();
      if (data.status === 'launched') {
        setSelectedCity('');
        fetchProvisionJobs();
      }
    } catch {}
  }, [selectedCity, selectedProfiles, fetchProvisionJobs]);

  const cancelJob = useCallback(async (region: string) => {
    try {
      await fetch(`/api/cities/${encodeURIComponent(region)}/cancel`, { method: 'POST' });
      fetchProvisionJobs();
    } catch {}
  }, [fetchProvisionJobs]);

  const dismissJob = useCallback(async (jobId: string) => {
    setProvisionJobs((prev) => prev.filter((j) => j.job_id !== jobId));
  }, []);

  const dropCity = useCallback(async (region: string) => {
    try {
      await fetch(`/api/cities/${encodeURIComponent(region)}`, { method: 'DELETE' });
      fetchCities();
      fetchProvisionJobs();
    } catch {}
  }, [fetchCities, fetchProvisionJobs]);

  const profileGroups = ALL_PROFILES.reduce<Record<string, typeof ALL_PROFILES>>((acc, p) => {
    (acc[p.group] = acc[p.group] || []).push(p);
    return acc;
  }, {});

  const activeJobs = provisionJobs.filter((j) => j.status === 'RUNNING' || j.status === 'PENDING');
  const recentJobs = provisionJobs.filter((j) => j.status !== 'RUNNING' && j.status !== 'PENDING').slice(0, 10);
  const canProvisionSelected = selectedCity && CITY_CATALOG[selectedCity] && !isRegionProvisioning(CITY_CATALOG[selectedCity]?.region || '');

  const getPhaseProgress = (stage: string) => {
    const idx = PHASE_ORDER.indexOf(stage.toLowerCase());
    return idx >= 0 ? idx : 0;
  };

  const getTimeSince = (timestamp: string) => {
    if (!timestamp) return '';
    const diff = Date.now() - new Date(timestamp + 'Z').getTime();
    const mins = Math.floor(diff / 60000);
    if (mins < 1) return 'just now';
    if (mins < 60) return `${mins}m ago`;
    const hrs = Math.floor(mins / 60);
    return `${hrs}h ${mins % 60}m ago`;
  };

  return (
    <div className="panel">
      <h2>City Provisioner</h2>
      <p className="subtitle">Deploy per-region ORS instances with region-parameterized routing functions</p>

      {activeJobs.length > 0 && (
        <>
          <h3>Active Provisioning Jobs</h3>
          <div className="job-cards">
            {activeJobs.map((job) => {
              const currentPhase = getPhaseProgress(job.stage);
              return (
                <div key={job.job_id} className="job-card active">
                  <div className="job-header">
                    <strong>{job.display_name || job.region}</strong>
                    <span className="badge running">{job.status}</span>
                    <button className="btn danger small" onClick={() => cancelJob(job.region)} style={{ marginLeft: 'auto' }}>Cancel</button>
                  </div>
                  <div className="provision-progress">
                    {PROVISION_PHASES.map((phase) => {
                      const pIdx = PHASE_ORDER.indexOf(phase.id);
                      const isDone = currentPhase > pIdx;
                      const isCurrent = job.stage.toLowerCase() === phase.id;
                      return (
                        <div key={phase.id} className={`progress-step ${isDone ? 'done' : ''} ${isCurrent ? 'active' : ''}`}>
                          <span className="step-icon">{isDone ? '\u2713' : isCurrent ? '\u27F3' : '\u25CB'}</span>
                          <span className="step-label">{phase.label}</span>
                          {isCurrent && job.message && <span className="step-message">{job.message}</span>}
                        </div>
                      );
                    })}
                  </div>
                  {job.profiles && <div className="job-meta">Profiles: {job.profiles}</div>}
                  {job.started_at && <div className="job-meta">Started {getTimeSince(job.started_at)}</div>}
                </div>
              );
            })}
          </div>
        </>
      )}

      <h3>Provisioned Cities</h3>
      {loading ? (
        <div className="loading-text">Loading...</div>
      ) : cities.length === 0 ? (
        <div className="empty-state">No cities provisioned yet. Select a city below to deploy.</div>
      ) : (
        <table className="services-table">
          <thead>
            <tr><th>Region</th><th>ORS Status</th><th>Functions</th><th>Actions</th></tr>
          </thead>
          <tbody>
            {cities.map((c) => (
              <tr key={c.region}>
                <td>{c.display_name || c.region}</td>
                <td><span className={`badge ${c.serviceStatus === 'RUNNING' ? 'ok' : 'warn'}`}>{c.serviceStatus}</span></td>
                <td>{c.functionExists ? '\u2713' : '\u2014'}</td>
                <td>
                  {c.isDefault ? (
                    <span className="badge ok">Built-in</span>
                  ) : (
                    <button className="btn danger small" onClick={() => dropCity(c.region)}>Drop</button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <h3>Provision New City</h3>
      <div className="provision-form">
        <select
          value={selectedCity}
          onChange={(e) => { setSelectedCity(e.target.value); setSelectedProfiles(DEFAULT_PROFILES); }}
          className="select"
        >
          <option value="">Select a city...</option>
          {Object.entries(CITY_CATALOG).map(([name, cfg]) => (
            <option key={name} value={name}>{name} ({cfg.region})</option>
          ))}
        </select>

        {selectedCity && CITY_CATALOG[selectedCity] && (
          <>
            <div className="city-info">
              <div className="info-row">
                <span className="info-label">Region:</span>
                <span>{CITY_CATALOG[selectedCity].region}</span>
              </div>
              <div className="info-row">
                <span className="info-label">Bounding Box:</span>
                <span>
                  {CITY_CATALOG[selectedCity].bbox.minLat.toFixed(2)} &mdash; {CITY_CATALOG[selectedCity].bbox.maxLat.toFixed(2)}N,{' '}
                  {CITY_CATALOG[selectedCity].bbox.minLon.toFixed(2)} &mdash; {CITY_CATALOG[selectedCity].bbox.maxLon.toFixed(2)}E
                </span>
              </div>
              <div className="info-row">
                <span className="info-label">PBF Source:</span>
                <span className="info-url">{CITY_CATALOG[selectedCity].pbfUrl}</span>
              </div>
            </div>

            <div className="profile-selector">
              <label className="info-label">Routing Profiles:</label>
              <p className="subtitle" style={{ margin: '4px 0 8px' }}>
                More profiles = longer graph build time and higher memory usage
              </p>
              {Object.entries(profileGroups).map(([group, profiles]) => (
                <div key={group} className="profile-group">
                  <span className="profile-group-label">{group}</span>
                  <div className="profile-checkboxes">
                    {profiles.map((p) => (
                      <label key={p.id} className="profile-checkbox">
                        <input
                          type="checkbox"
                          checked={selectedProfiles.includes(p.id)}
                          onChange={() => toggleProfile(p.id)}
                        />
                        <span>{p.label}</span>
                      </label>
                    ))}
                  </div>
                </div>
              ))}
              <div style={{ fontSize: '12px', color: '#888', marginTop: '4px' }}>
                {selectedProfiles.length} profile{selectedProfiles.length !== 1 ? 's' : ''} selected
              </div>
            </div>

            {isRegionProvisioning(CITY_CATALOG[selectedCity]?.region || '') && (
              <div className="warning-banner">This region is already being provisioned.</div>
            )}
          </>
        )}

        <button
          className="btn primary"
          onClick={startProvision}
          disabled={!canProvisionSelected || selectedProfiles.length === 0}
        >
          {`Deploy ORS for ${selectedCity || '...'}`}
        </button>
      </div>

      {recentJobs.length > 0 && (
        <>
          <h3>Recent Jobs</h3>
          <table className="services-table">
            <thead>
              <tr><th>Region</th><th>Status</th><th>Message</th><th>Time</th><th></th></tr>
            </thead>
            <tbody>
              {recentJobs.map((job) => (
                <tr key={job.job_id}>
                  <td>{job.display_name || job.region}</td>
                  <td>
                    <span className={`badge ${job.status === 'COMPLETE' ? 'ok' : job.status === 'ERROR' ? 'error' : 'warn'}`}>
                      {job.status}
                    </span>
                  </td>
                  <td style={{ maxWidth: '300px', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                    {job.status === 'ERROR' ? job.error_msg : job.message}
                  </td>
                  <td>{job.completed_at ? getTimeSince(job.completed_at) : job.created_at ? getTimeSince(job.created_at) : ''}</td>
                  <td><button className="btn small" onClick={() => dismissJob(job.job_id)}>Dismiss</button></td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
    </div>
  );
}

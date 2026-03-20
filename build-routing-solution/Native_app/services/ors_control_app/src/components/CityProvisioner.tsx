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

interface ProvisionProgress {
  status: string;
  phase: string;
  message?: string;
  error?: string;
}

const PROVISION_PHASES = [
  { id: 'downloading_pbf', label: 'Download Map Data', icon: '📦' },
  { id: 'creating_pool', label: 'Create Compute Pool', icon: '🖥' },
  { id: 'creating_service', label: 'Start ORS Service', icon: '🔧' },
  { id: 'building_graph', label: 'Build Routing Graph', icon: '🗺' },
  { id: 'creating_functions', label: 'Create Functions', icon: '⚡' },
];

const PHASE_ORDER = ['idle', 'downloading_pbf', 'creating_pool', 'creating_service', 'building_graph', 'creating_functions', 'ready'];

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
  const [provisioning, setProvisioning] = useState(false);
  const [progress, setProgress] = useState<ProvisionProgress | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const fetchCities = useCallback(async () => {
    try {
      const r = await fetch('/api/cities');
      const data = await r.json();
      setCities(data.cities || []);
    } catch {}
    setLoading(false);
  }, []);

  useEffect(() => {
    fetchCities();
    return () => { if (pollRef.current) clearInterval(pollRef.current); };
  }, [fetchCities]);

  const toggleProfile = useCallback((profileId: string) => {
    setSelectedProfiles((prev) =>
      prev.includes(profileId) ? prev.filter((p) => p !== profileId) : [...prev, profileId]
    );
  }, []);

  const startProvision = useCallback(async () => {
    if (!selectedCity) return;
    const config = CITY_CATALOG[selectedCity];
    if (!config) return;
    if (selectedProfiles.length === 0) return;

    setProvisioning(true);
    setProgress({ status: 'started', phase: 'downloading_pbf' });

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
      if (data.status === 'started') {
        pollRef.current = setInterval(async () => {
          try {
            const pr = await fetch(`/api/cities/${encodeURIComponent(config.region)}/progress`);
            const pd = await pr.json();
            setProgress(pd);
            if (pd.status === 'complete' || pd.status === 'error') {
              if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; }
              setProvisioning(false);
              fetchCities();
            }
          } catch {}
        }, 3000);
      }
    } catch (err: any) {
      setProvisioning(false);
      setProgress({ status: 'error', phase: '', error: err.message });
    }
  }, [selectedCity, selectedProfiles, fetchCities]);

  const dropCity = useCallback(async (region: string) => {
    try {
      await fetch(`/api/cities/${encodeURIComponent(region)}`, { method: 'DELETE' });
      fetchCities();
    } catch {}
  }, [fetchCities]);

  const phaseIdx = progress ? PHASE_ORDER.indexOf(progress.phase) : -1;

  const profileGroups = ALL_PROFILES.reduce<Record<string, typeof ALL_PROFILES>>((acc, p) => {
    (acc[p.group] = acc[p.group] || []).push(p);
    return acc;
  }, {});

  return (
    <div className="panel">
      <h2>City Provisioner</h2>
      <p className="subtitle">Deploy per-region ORS instances with city-prefixed routing functions</p>

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
                <td>{c.functionExists ? '✓' : '—'}</td>
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
          disabled={provisioning}
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
                  {CITY_CATALOG[selectedCity].bbox.minLat.toFixed(2)}° — {CITY_CATALOG[selectedCity].bbox.maxLat.toFixed(2)}°N,{' '}
                  {CITY_CATALOG[selectedCity].bbox.minLon.toFixed(2)}° — {CITY_CATALOG[selectedCity].bbox.maxLon.toFixed(2)}°E
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
                          disabled={provisioning}
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
          </>
        )}

        <button
          className="btn primary"
          onClick={startProvision}
          disabled={!selectedCity || provisioning || selectedProfiles.length === 0}
        >
          {provisioning ? 'Provisioning...' : `Deploy ORS for ${selectedCity || '...'}`}
        </button>
      </div>

      {provisioning && progress && (
        <div className="provision-progress">
          <h3>Provisioning Progress</h3>
          {PROVISION_PHASES.map((phase) => {
            const pIdx = PHASE_ORDER.indexOf(phase.id);
            const isDone = phaseIdx > pIdx;
            const isCurrent = progress.phase === phase.id;
            return (
              <div key={phase.id} className={`progress-step ${isDone ? 'done' : ''} ${isCurrent ? 'active' : ''}`}>
                <span className="step-icon">
                  {isDone ? '✓' : isCurrent ? '⟳' : phase.icon}
                </span>
                <span className="step-label">{phase.label}</span>
                {isCurrent && progress.message && (
                  <span className="step-message">{progress.message}</span>
                )}
              </div>
            );
          })}
          {progress.status === 'error' && (
            <div className="error-banner">{progress.error}</div>
          )}
        </div>
      )}
    </div>
  );
}

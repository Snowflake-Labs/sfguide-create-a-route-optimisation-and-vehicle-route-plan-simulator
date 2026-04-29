import { useState, useCallback, useEffect, useRef, useMemo } from 'react';
import type { CatalogRegion } from '../types';

interface GraphInfo {
  profile: string;
  ready: boolean;
  build_date?: string | null;
}

interface GraphReadiness {
  service_ready: boolean;
  profiles_loaded: string[];
  expected_profiles: string[];
  graphs: GraphInfo[];
  error?: string;
}

interface RegionStatus {
  region: string;
  display_name?: string;
  status: string;
  serviceStatus: string;
  pbfDownloaded: boolean;
  functionExists: boolean;
  isDefault?: boolean;
  graphReadiness?: GraphReadiness | null;
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

type ComputeSize = 'S' | 'M' | 'L' | 'XL';

const COMPUTE_SIZES: { id: ComputeSize; label: string; instance: string; vcpu: number; mem: string; heap: string; desc: string }[] = [
  { id: 'S', label: 'Small', instance: 'CPU_X64_M', vcpu: 6, mem: '28 GB', heap: '20 GB', desc: 'Cities and small regions' },
  { id: 'M', label: 'Medium', instance: 'CPU_X64_SL', vcpu: 14, mem: '58 GB', heap: '44 GB', desc: 'Sub-regions and small countries' },
  { id: 'L', label: 'Large', instance: 'CPU_X64_L', vcpu: 28, mem: '116 GB', heap: '96 GB', desc: 'Countries and continents' },
  { id: 'XL', label: 'Extra Large', instance: 'HIGHMEM_X64_M', vcpu: 28, mem: '240 GB', heap: '200 GB', desc: 'Large countries (US, Russia, etc.)' },
];

function recommendComputeSize(level: string | undefined): ComputeSize {
  switch (level) {
    case 'city': return 'S';
    case 'sub-region': return 'M';
    case 'country': return 'L';
    case 'continent': return 'XL';
    default: return 'M';
  }
}

type SourceTab = 'bbbike' | 'geofabrik';

function sizeLabel(mb: number | undefined | null): string {
  if (mb == null) return '—';
  if (mb >= 1024) return `${(mb / 1024).toFixed(1)} GB`;
  return `${Math.round(mb)} MB`;
}

function sizeClass(mb: number | undefined | null): string {
  if (mb == null) return '';
  if (mb < 100) return 'size-small';
  if (mb < 500) return 'size-medium';
  if (mb < 2048) return 'size-large';
  return 'size-xlarge';
}

function estTime(mb: number | undefined | null): string {
  if (mb == null) return '—';
  if (mb < 100) return '~5 min';
  if (mb < 500) return '~10-30 min';
  if (mb < 2048) return '~30-60 min';
  return '1+ hours';
}

function toCatalogRegion(row: any): CatalogRegion {
  return {
    catalogId: row.CATALOG_ID,
    source: row.SOURCE,
    regionName: row.REGION_NAME,
    regionKey: row.REGION_KEY,
    hierarchy: row.HIERARCHY || undefined,
    continent: row.CONTINENT || undefined,
    country: row.COUNTRY || undefined,
    pbfUrl: row.PBF_URL,
    pbfSizeMb: row.PBF_SIZE_MB ?? undefined,
    level: row.LEVEL,
    bbox: row.MIN_LAT != null ? { minLat: Number(row.MIN_LAT), maxLat: Number(row.MAX_LAT), minLon: Number(row.MIN_LON), maxLon: Number(row.MAX_LON) } : undefined,
  };
}

export default function RegionBuilder() {
  const [regions, setRegions] = useState<RegionStatus[]>([]);
  const [catalog, setCatalog] = useState<CatalogRegion[]>([]);
  const [loading, setLoading] = useState(true);
  const [catalogLoading, setCatalogLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [sourceTab, setSourceTab] = useState<SourceTab>('bbbike');
  const [search, setSearch] = useState('');
  const [selectedRegion, setSelectedRegion] = useState<CatalogRegion | null>(null);
  const [selectedProfiles, setSelectedProfiles] = useState<string[]>(DEFAULT_PROFILES);
  const [computeSize, setComputeSize] = useState<ComputeSize>('S');
  const [provisionJobs, setProvisionJobs] = useState<ProvisionJob[]>([]);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const autoRefreshedRef = useRef(false);
  const [buildProgress, setBuildProgress] = useState<Record<string, {
    phase: string; progress: number; profileProgress?: number; nodesRemaining?: number; nodesTotal?: number;
    currentProfile?: string | null; completedProfiles?: string[]; totalProfiles?: number; detail?: string;
  }>>({});

  const fetchRegions = useCallback(async () => {
    try {
      const r = await fetch('/api/regions/provisioned');
      const data = await r.json();
      setRegions(data.regions || []);
    } catch {}
    setLoading(false);
  }, []);

  const fetchCatalog = useCallback(async () => {
    setCatalogLoading(true);
    try {
      const r = await fetch('/api/regions/catalog');
      const data = await r.json();
      const items = (data.catalog || []).map(toCatalogRegion);
      setCatalog(items);
      if (items.length === 0 && !autoRefreshedRef.current) {
        autoRefreshedRef.current = true;
        setRefreshing(true);
        try {
          await fetch('/api/regions/catalog/refresh', { method: 'POST' });
          const r2 = await fetch('/api/regions/catalog');
          const data2 = await r2.json();
          setCatalog((data2.catalog || []).map(toCatalogRegion));
        } catch {}
        setRefreshing(false);
      }
    } catch {}
    setCatalogLoading(false);
  }, []);

  const fetchProvisionJobs = useCallback(async () => {
    try {
      const r = await fetch('/api/regions/provision/status');
      const data = await r.json();
      setProvisionJobs(data.jobs || []);
    } catch {}
  }, []);

  const hasActiveJobs = provisionJobs.some((j) => j.status === 'RUNNING' || j.status === 'PENDING');

  useEffect(() => {
    fetchRegions();
    fetchCatalog();
    fetchProvisionJobs();
  }, [fetchRegions, fetchCatalog, fetchProvisionJobs]);

  useEffect(() => {
    if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; }
    if (!hasActiveJobs) return;
    pollRef.current = setInterval(() => {
      fetchProvisionJobs();
      fetchRegions();
    }, 3000);
    return () => { if (pollRef.current) clearInterval(pollRef.current); };
  }, [hasActiveJobs, fetchProvisionJobs, fetchRegions]);

  const activeJobs = provisionJobs.filter((j) => j.status === 'RUNNING' || j.status === 'PENDING');

  const buildingRegions = useMemo(() => {
    const fromJobs = activeJobs
      .filter(j => ['building_graph', 'waiting_for_service'].includes(j.stage.toLowerCase()))
      .map(j => j.region);
    const fromProvisioned = regions
      .filter(r => r.serviceStatus === 'RUNNING' && !r.isDefault)
      .map(r => r.region);
    return [...new Set([...fromJobs, ...fromProvisioned])];
  }, [activeJobs, regions]);

  useEffect(() => {
    if (buildingRegions.length === 0) { setBuildProgress({}); return; }
    const poll = () => {
      buildingRegions.forEach(region => {
        fetch(`/api/regions/${region}/build-progress`)
          .then(r => r.json())
          .then(data => setBuildProgress(prev => {
            if (data.phase === 'ready' && prev[region]?.phase === 'ready') return prev;
            return { ...prev, [region]: data };
          }))
          .catch(() => {});
      });
    };
    poll();
    const id = setInterval(poll, 5000);
    return () => clearInterval(id);
  }, [buildingRegions.join(',')]);

  const refreshCatalog = useCallback(async () => {
    setRefreshing(true);
    try {
      await fetch('/api/regions/catalog/refresh', { method: 'POST' });
      await fetchCatalog();
    } catch {}
    setRefreshing(false);
  }, [fetchCatalog]);

  const toggleProfile = useCallback((profileId: string) => {
    setSelectedProfiles((prev) =>
      prev.includes(profileId) ? prev.filter((p) => p !== profileId) : [...prev, profileId]
    );
  }, []);

  const isRegionProvisioning = useCallback((regionKey: string) => {
    return provisionJobs.some((j) => j.region.toUpperCase() === regionKey.toUpperCase() && (j.status === 'RUNNING' || j.status === 'PENDING'));
  }, [provisionJobs]);

  const startProvision = useCallback(async () => {
    if (!selectedRegion) return;
    if (selectedProfiles.length === 0) return;
    try {
      const resp = await fetch('/api/regions/provision', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          city: selectedRegion.regionName,
          region: selectedRegion.regionKey,
          pbf_url: selectedRegion.pbfUrl,
          bbox: selectedRegion.bbox || { minLat: 0, maxLat: 0, minLon: 0, maxLon: 0 },
          profiles: selectedProfiles,
          compute_size: computeSize,
        }),
      });
      const data = await resp.json();
      if (data.status === 'launched') {
        setSelectedRegion(null);
        fetchProvisionJobs();
      }
    } catch {}
  }, [selectedRegion, selectedProfiles, fetchProvisionJobs]);

  const cancelJob = useCallback(async (region: string) => {
    try {
      await fetch(`/api/regions/${encodeURIComponent(region)}/cancel`, { method: 'POST' });
      fetchProvisionJobs();
    } catch {}
  }, [fetchProvisionJobs]);

  const dismissJob = useCallback(async (jobId: string) => {
    setProvisionJobs((prev) => prev.filter((j) => j.job_id !== jobId));
  }, []);

  const retryJob = useCallback((job: ProvisionJob) => {
    const match = catalog.find((r) => r.regionKey.toUpperCase() === job.region.toUpperCase());
    if (match) {
      setSelectedRegion(match);
      const profiles = job.profiles ? job.profiles.split(',').map(p => p.trim()).filter(Boolean) : DEFAULT_PROFILES;
      setSelectedProfiles(profiles);
      setComputeSize(recommendComputeSize(match.level));
    }
  }, [catalog]);

  const dropRegion = useCallback(async (region: string) => {
    try {
      await fetch(`/api/regions/${encodeURIComponent(region)}`, { method: 'DELETE' });
      fetchRegions();
      fetchProvisionJobs();
    } catch {}
  }, [fetchRegions, fetchProvisionJobs]);

  const profileGroups = ALL_PROFILES.reduce<Record<string, typeof ALL_PROFILES>>((acc, p) => {
    (acc[p.group] = acc[p.group] || []).push(p);
    return acc;
  }, {});

  const filteredCatalog = useMemo(() => {
    const words = search.toLowerCase().split(/\s+/).filter(Boolean);
    const filtered = catalog.filter((r) => {
      if (r.source !== sourceTab) return false;
      if (words.length === 0) return true;
      const haystack = [r.regionName, r.continent || '', r.country || ''].join(' ').toLowerCase();
      return words.every((w) => haystack.includes(w));
    });
    const seen = new Set<string>();
    return filtered.filter((r) => {
      const key = `${r.regionKey}:${r.country || ''}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }, [catalog, sourceTab, search]);

  useEffect(() => {
    if (selectedRegion && !filteredCatalog.some(r => r.catalogId === selectedRegion.catalogId)) {
      setSelectedRegion(null);
    }
  }, [filteredCatalog, selectedRegion]);

  const finishedJobs = provisionJobs.filter((j) => j.status !== 'RUNNING' && j.status !== 'PENDING');
  const failedJobs = finishedJobs.filter((j) => j.status === 'ERROR' || j.status === 'CANCELLED').slice(0, 10);
  const completedJobs = finishedJobs.filter((j) => j.status !== 'ERROR' && j.status !== 'CANCELLED').slice(0, 10);
  const canProvisionSelected = selectedRegion && !isRegionProvisioning(selectedRegion.regionKey);

  const getPhaseProgress = (stage: string) => {
    const idx = PHASE_ORDER.indexOf(stage.toLowerCase());
    return idx >= 0 ? idx : 0;
  };

  const getTimeSince = (timestamp: string) => {
    if (!timestamp) return '';
    const diff = Date.now() - new Date(timestamp).getTime();
    const mins = Math.floor(diff / 60000);
    if (mins < 1) return 'just now';
    if (mins < 60) return `${mins}m ago`;
    const hrs = Math.floor(mins / 60);
    return `${hrs}h ${mins % 60}m ago`;
  };

  return (
    <div className="panel">
      <h2>Region Builder</h2>
      <p className="subtitle">Deploy per-region ORS instances from OSM map data (Geofabrik + BBBike)</p>

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
                          {isCurrent && phase.id === 'building_graph' && buildProgress[job.region]?.phase === 'building' && (
                            <div className="build-progress">
                              <div className="progress-bar-track">
                                <div className="progress-bar-fill" style={{ width: `${buildProgress[job.region].progress}%` }} />
                              </div>
                              <div className="progress-stats">
                                <span>{buildProgress[job.region].progress}%</span>
                                {buildProgress[job.region].currentProfile && buildProgress[job.region].totalProfiles && (
                                  <span>Profile {(buildProgress[job.region].completedProfiles?.length ?? 0) + 1}/{buildProgress[job.region].totalProfiles}: {buildProgress[job.region].currentProfile}</span>
                                )}
                                {(buildProgress[job.region].nodesRemaining ?? 0) > 0 && (
                                  <span>{((buildProgress[job.region].nodesRemaining ?? 0) / 1000).toFixed(0)}K nodes left</span>
                                )}
                              </div>
                            </div>
                          )}
                          {isCurrent && (phase.id === 'building_graph' || phase.id === 'waiting_for_service') && buildProgress[job.region]?.phase === 'initializing' && (
                            <span className="step-message">ORS engine starting up...</span>
                          )}
                          {isCurrent && (phase.id === 'building_graph' || phase.id === 'waiting_for_service') && buildProgress[job.region]?.phase === 'importing' && (
                            <span className="step-message">Importing OSM data for {buildProgress[job.region].currentProfile}...</span>
                          )}
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

      <h3>Provisioned Regions</h3>
      {loading ? (
        <div className="loading-text">Loading...</div>
      ) : regions.length === 0 ? (
        <div className="empty-state">No regions provisioned yet. Select a region below to deploy.</div>
      ) : (
        <table className="services-table">
          <thead>
            <tr><th>Region</th><th>Service</th><th>Graphs</th><th>Functions</th><th>Actions</th></tr>
          </thead>
          <tbody>
            {regions.map((c) => {
              const bp = buildProgress[c.region];
              const isBuilding = bp && bp.phase !== 'ready' && bp.phase !== 'unknown' && !c.isDefault;
              const gr = c.graphReadiness;
              const readyCount = gr?.graphs?.filter(g => g.ready).length ?? 0;
              const totalCount = gr?.graphs?.length ?? 0;
              return (
              <tr key={c.region}>
                <td>{c.display_name || c.region}</td>
                <td>
                  <span className={`badge ${c.serviceStatus === 'RUNNING' ? 'ok' : 'warn'}`}>{c.serviceStatus}</span>
                  {isBuilding && bp.phase === 'building' && (
                    <div className="build-progress inline">
                      <div className="progress-bar-track">
                        <div className="progress-bar-fill" style={{ width: `${bp.progress}%` }} />
                      </div>
                      <div className="progress-stats">
                        <span>{bp.progress}%</span>
                        {bp.currentProfile && bp.totalProfiles && (
                          <span>{(bp.completedProfiles?.length ?? 0) + 1}/{bp.totalProfiles}: {bp.currentProfile}</span>
                        )}
                      </div>
                    </div>
                  )}
                  {isBuilding && bp.phase === 'importing' && (
                    <div className="build-progress inline"><span className="step-message">Importing OSM for {bp.currentProfile}...</span></div>
                  )}
                  {isBuilding && bp.phase === 'initializing' && (
                    <div className="build-progress inline"><span className="step-message">ORS starting up...</span></div>
                  )}
                  {isBuilding && bp.phase === 'finalizing' && (
                    <div className="build-progress inline"><span className="step-message">Finalizing...</span></div>
                  )}
                </td>
                <td>
                  {c.serviceStatus !== 'RUNNING' && c.serviceStatus !== 'READY' ? (
                    <span style={{ color: 'var(--text-secondary)', fontSize: 12 }}>Service not running</span>
                  ) : !gr ? (
                    <span style={{ color: 'var(--text-secondary)', fontSize: 12 }}>Checking...</span>
                  ) : gr.error ? (
                    <>
                      <span className="badge error">Failed</span>
                      <div style={{ fontSize: 11, color: '#e53935', marginTop: 2, maxWidth: 200, overflow: 'hidden', textOverflow: 'ellipsis' }} title={gr.error}>
                        {gr.error.length > 80 ? gr.error.slice(0, 80) + '...' : gr.error}
                      </div>
                    </>
                  ) : gr.service_ready && readyCount === totalCount && totalCount > 0 ? (
                    <>
                      <span className="badge ok">{readyCount}/{totalCount} ready</span>
                      <ul style={{ margin: '4px 0 0', paddingLeft: 16, listStyle: 'none', fontSize: 11 }}>
                        {gr.graphs.map(g => (
                          <li key={g.profile} style={{ color: 'var(--color-ok)' }}>
                            {'\u2713'} {g.profile}{g.build_date ? ` (${g.build_date})` : ''}
                          </li>
                        ))}
                      </ul>
                    </>
                  ) : (
                    <>
                      <span className="badge warn">Building {readyCount}/{totalCount}</span>
                      {totalCount > 0 && (
                        <ul style={{ margin: '4px 0 0', paddingLeft: 16, listStyle: 'none', fontSize: 11 }}>
                          {gr.graphs.map(g => (
                            <li key={g.profile} style={{ color: g.ready ? 'var(--color-ok)' : 'var(--text-secondary)' }}>
                              {g.ready ? '\u2713' : '\u25CB'} {g.profile}{g.build_date ? ` (${g.build_date})` : ''}
                            </li>
                          ))}
                        </ul>
                      )}
                    </>
                  )}
                </td>
                <td>{c.functionExists ? '\u2713' : '\u2014'}</td>
                <td>
                  {c.isDefault ? (
                    <span className="badge ok">Built-in</span>
                  ) : (
                    <button className="btn danger small" onClick={() => dropRegion(c.region)}>Drop</button>
                  )}
                </td>
              </tr>
              );
            })}
          </tbody>
        </table>
      )}

      <h3>Provision New Region</h3>
      <div className="provision-form">
        <div style={{ display: 'flex', gap: '0.5rem', marginBottom: '0.75rem', alignItems: 'center' }}>
          <div style={{ display: 'flex', borderRadius: '6px', overflow: 'hidden', border: '1px solid var(--border)' }}>
            <button
              className={`btn small${sourceTab === 'bbbike' ? ' primary' : ''}`}
              onClick={() => { setSourceTab('bbbike'); setSelectedRegion(null); }}
              style={{ borderRadius: 0 }}
            >
              BBBike Cities
            </button>
            <button
              className={`btn small${sourceTab === 'geofabrik' ? ' primary' : ''}`}
              onClick={() => { setSourceTab('geofabrik'); setSelectedRegion(null); }}
              style={{ borderRadius: 0 }}
            >
              Geofabrik Regions
            </button>
          </div>
          <input
            type="text"
            placeholder="Search regions..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="select"
            style={{ flex: 1, minWidth: 0 }}
          />
          <button className="btn small" onClick={refreshCatalog} disabled={refreshing}>
            {refreshing ? 'Refreshing...' : 'Refresh Catalog'}
          </button>
        </div>

        {(catalogLoading || refreshing) && catalog.length === 0 ? (
          <div className="empty-state" style={{ textAlign: 'center', padding: '2rem 1rem' }}>
            <div className="loading-text" style={{ marginBottom: '0.5rem' }}>Loading region catalog...</div>
            <p style={{ color: '#888', fontSize: '13px', margin: 0 }}>
              First load may take 2-3 minutes while we fetch available regions from Geofabrik and BBBike.
            </p>
          </div>
        ) : catalogLoading ? (
          <div className="loading-text">Loading catalog...</div>
        ) : catalog.length === 0 ? (
          <div className="empty-state">
            Catalog is empty. Click &quot;Refresh Catalog&quot; to load available regions from Geofabrik and BBBike.
          </div>
        ) : (
          <div style={{ maxHeight: '320px', overflowY: 'auto', border: '1px solid var(--border)', borderRadius: '6px' }}>
            <table className="services-table" style={{ margin: 0 }}>
              <thead>
                <tr>
                  <th>Region</th>
                  <th>Location</th>
                  <th>Level</th>
                  <th>Size</th>
                  <th>Est. Time</th>
                </tr>
              </thead>
              <tbody>
                {filteredCatalog.length === 0 ? (
                  <tr><td colSpan={5} style={{ textAlign: 'center', padding: '1rem', color: '#888' }}>No regions match your search</td></tr>
                ) : filteredCatalog.map((r) => {
                  const isSelected = selectedRegion?.catalogId === r.catalogId;
                  return (
                  <tr
                    key={r.catalogId}
                    onClick={() => { setSelectedRegion(r); setSelectedProfiles(DEFAULT_PROFILES); setComputeSize(recommendComputeSize(r.level)); }}
                    style={{ cursor: 'pointer', background: isSelected ? 'rgba(59,130,246,0.25)' : undefined, outline: isSelected ? '2px solid rgba(59,130,246,0.6)' : undefined }}
                  >
                    <td><strong>{r.regionName}</strong></td>
                    <td>{r.source === 'bbbike' ? 'City' : [r.continent, r.country].filter(Boolean).join(' / ') || '—'}</td>
                    <td><span className="badge">{r.level}</span></td>
                    <td><span className={sizeClass(r.pbfSizeMb)}>{sizeLabel(r.pbfSizeMb)}</span></td>
                    <td>{estTime(r.pbfSizeMb)}</td>
                  </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}

        {selectedRegion && (
          <>
            <div className="city-info" style={{ marginTop: '0.75rem' }}>
              <div className="info-row">
                <span className="info-label">Region Key:</span>
                <span>{selectedRegion.regionKey}</span>
              </div>
              <div className="info-row">
                <span className="info-label">PBF Source:</span>
                <span className="info-url">{selectedRegion.pbfUrl}</span>
              </div>
              {selectedRegion.bbox && (
                <div className="info-row">
                  <span className="info-label">Bounding Box:</span>
                  <span>
                    {selectedRegion.bbox.minLat.toFixed(2)} &mdash; {selectedRegion.bbox.maxLat.toFixed(2)}N,{' '}
                    {selectedRegion.bbox.minLon.toFixed(2)} &mdash; {selectedRegion.bbox.maxLon.toFixed(2)}E
                  </span>
                </div>
              )}
            </div>

            {(selectedRegion.pbfSizeMb ?? 0) > 500 && (
              <div className="warning-banner" style={{ marginTop: '0.5rem' }}>
                Large region warning: PBF is {sizeLabel(selectedRegion.pbfSizeMb)}. Graph building will take {estTime(selectedRegion.pbfSizeMb)} and require significant memory.
              </div>
            )}

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

            <div className="profile-selector" style={{ marginTop: '0.5rem' }}>
              <label className="info-label">Compute Size:</label>
              <p className="subtitle" style={{ margin: '4px 0 8px' }}>
                Auto-selected based on region level. Larger regions need more memory for graph building.
              </p>
              <div style={{ display: 'flex', gap: '0.5rem' }}>
                {COMPUTE_SIZES.map((s) => (
                  <button
                    key={s.id}
                    className={`btn small${computeSize === s.id ? ' primary' : ''}`}
                    onClick={() => setComputeSize(s.id)}
                    style={{ flex: 1, textAlign: 'center' }}
                  >
                    <div><strong>{s.label}</strong></div>
                    <div style={{ fontSize: '11px', opacity: 0.8 }}>{s.vcpu} vCPU / {s.mem}</div>
                    <div style={{ fontSize: '11px', opacity: 0.7 }}>{s.instance} / {s.heap} heap</div>
                  </button>
                ))}
              </div>
            </div>

            {isRegionProvisioning(selectedRegion.regionKey) && (
              <div className="warning-banner">This region is already being provisioned.</div>
            )}
          </>
        )}

        <button
          className="btn primary"
          onClick={startProvision}
          disabled={!canProvisionSelected || selectedProfiles.length === 0}
        >
          {`Deploy ORS for ${selectedRegion?.regionName || '...'}`}
        </button>
      </div>

      {failedJobs.length > 0 && (
        <>
          <h3>Failed Jobs</h3>
          {failedJobs.map((job) => (
            <div key={job.job_id} style={{ margin: '8px 0', padding: '12px 16px', background: 'rgba(229, 57, 53, 0.12)', borderRadius: 8, border: '1px solid rgba(229, 57, 53, 0.4)' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
                <div>
                  <strong>{job.display_name || job.region}</strong>
                  <span className="badge error" style={{ marginLeft: 8 }}>{job.status}</span>
                  {job.completed_at && <span style={{ fontSize: 11, color: 'var(--text-secondary)', marginLeft: 8 }}>{getTimeSince(job.completed_at)}</span>}
                </div>
                <div style={{ display: 'flex', gap: '0.5rem' }}>
                  <button className="btn small primary" onClick={() => retryJob(job)}>Retry</button>
                  <button className="btn small" onClick={() => dismissJob(job.job_id)}>Dismiss</button>
                </div>
              </div>
              <div style={{ fontSize: 12, color: '#e53935', whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
                {job.error_msg || job.message || 'Unknown error'}
              </div>
              {job.profiles && <div style={{ fontSize: 11, color: 'var(--text-secondary)', marginTop: 4 }}>Profiles: {job.profiles}</div>}
            </div>
          ))}
        </>
      )}

      {completedJobs.length > 0 && (
        <>
          <h3>Recent Jobs</h3>
          <table className="services-table">
            <thead>
              <tr><th>Region</th><th>Status</th><th>Message</th><th>Time</th><th></th></tr>
            </thead>
            <tbody>
              {completedJobs.map((job) => (
                <tr key={job.job_id}>
                  <td>{job.display_name || job.region}</td>
                  <td>
                    <span className="badge ok">{job.status}</span>
                  </td>
                  <td style={{ maxWidth: '300px', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                    {job.message}
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
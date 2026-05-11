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

type ComputeSize = 'S' | 'L' | 'XXL';

const COMPUTE_SIZES: { id: ComputeSize; label: string; instance: string; vcpu: number; mem: string; heap: string; desc: string }[] = [
  { id: 'S',   label: 'Small',             instance: 'GEN_X64_G2_8',   vcpu: 6,   mem: '28 GB',   heap: '20 GB',   desc: 'Cities (e.g. San Francisco, London)' },
  { id: 'L',   label: 'Large',             instance: 'HIGHMEM_X64_L',  vcpu: 124, mem: '984 GB',  heap: '700 GB',  desc: 'States or single countries (e.g. USA, Germany, California)' },
  { id: 'XXL', label: 'Extra Extra Large', instance: 'MEM_X64_G2_192', vcpu: 188, mem: '1436 GB', heap: '1100 GB', desc: 'Continents or super-regions (e.g. Europe, North America)' },
];

// Auto-recommend a tier from the region's level field.
//   city                      -> S   (GEN_X64_G2_8)
//   country / sub-region      -> L   (HIGHMEM_X64_L, ~700 G heap)
//   continent / unknown       -> XXL (MEM_X64_G2_192, ~1100 G heap)
// After first successful build, PROVISION_REGION_WRAPPER auto-calls
// DOWNSIZE_REGION_AFTER_BUILD so the runtime service does not pay
// build-tier rates 24/7. No user action required.
function recommendComputeSize(level: string | undefined): ComputeSize {
  if (level === 'city') return 'S';
  if (level === 'country' || level === 'sub-region') return 'L';
  return 'XXL';
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
  const [computeSize, setComputeSize] = useState<ComputeSize>('L');
  // PBF source preference. Default false = reuse the staged .osm.pbf when
  // present (turns multi-GB redeploys into seconds). True = force a fresh
  // download from Geofabrik / BBBike, e.g. to pick up a weekly refresh.
  const [forcePbfRedownload, setForcePbfRedownload] = useState<boolean>(false);
  // Largest high-memory family resolved on the server via
  // RESOLVE_LARGEST_HIGHMEM_FAMILY(); used in the XXL banner so users see
  // exactly which instance family will back their build before they click
  // Deploy. Falls back to the published default if the API call fails.
  const [largestFamily, setLargestFamily] = useState<string>('MEM_X64_G2_192');
  useEffect(() => {
    let cancelled = false;
    fetch('/api/regions/largest-family')
      .then((r) => r.json())
      .then((d) => {
        if (!cancelled && d && d.family) setLargestFamily(d.family);
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, []);
  // Healthcheck for new build-routing-solution procs/tables. If the SQL
  // modules were not deployed alongside this image, the UI would silently
  // fall back to hardcoded defaults; surfacing a banner makes partial
  // deploys obvious instead of degrading quietly.
  type HealthStatus = { overall: string; status: Record<string, string>; errors?: Record<string, string> };
  const [health, setHealth] = useState<HealthStatus | null>(null);
  useEffect(() => {
    let cancelled = false;
    fetch('/api/regions/healthcheck')
      .then((r) => r.json())
      .then((d: HealthStatus) => { if (!cancelled) setHealth(d); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, []);
  // Aggregated build history across all provisioned regions, fed by
  // /api/regions/:region/build-history. Refreshed whenever the regions list
  // changes so a freshly-completed build shows up in the recent-builds card.
  type BuildHistoryRow = {
    BUILD_ID?: string;
    REGION?: string;
    INSTANCE_FAMILY?: string;
    COMPUTE_SIZE?: string;
    PROFILES?: string;
    JVM_XMX_GIB?: number;
    STARTED_AT?: string;
    FINISHED_AT?: string;
    ELAPSED_MINUTES?: number;
    EXIT_STATUS?: string;
    PEAK_RSS_GIB?: number | null;
    OUTPUT_GRAPH_GIB?: number | null;
  };
  const [buildHistory, setBuildHistory] = useState<BuildHistoryRow[]>([]);
  const [provisionJobs, setProvisionJobs] = useState<ProvisionJob[]>([]);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const autoRefreshedRef = useRef(false);
  const [buildProgress, setBuildProgress] = useState<Record<string, {
    phase: string; progress: number; profileProgress?: number; nodesRemaining?: number; nodesTotal?: number;
    currentProfile?: string | null; completedProfiles?: string[]; totalProfiles?: number; detail?: string;
  }>>({});
  const [diagState, setDiagState] = useState<Record<string, {
    loading: boolean;
    markdown?: string;
    error?: string;
    raw?: any;
    expanded: boolean;
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

  // Fetch the latest build history rows for every provisioned region whenever
  // the regions list changes. Each region returns up to 25 rows; we then sort
  // by STARTED_AT desc and keep only the most recent 10 across the whole
  // account so the card stays compact.
  useEffect(() => {
    let cancelled = false;
    if (regions.length === 0) {
      setBuildHistory([]);
      return;
    }
    Promise.all(
      regions.map((c) =>
        fetch(`/api/regions/${encodeURIComponent(c.region)}/build-history`)
          .then((r) => r.json())
          .then((d) => (Array.isArray(d?.history) ? d.history : []))
          .catch(() => [])
      )
    ).then((all) => {
      if (cancelled) return;
      const flat: BuildHistoryRow[] = ([] as BuildHistoryRow[]).concat(...all);
      flat.sort((a, b) => {
        const ta = a.STARTED_AT ? new Date(a.STARTED_AT).getTime() : 0;
        const tb = b.STARTED_AT ? new Date(b.STARTED_AT).getTime() : 0;
        return tb - ta;
      });
      setBuildHistory(flat.slice(0, 10));
    });
    return () => { cancelled = true; };
  }, [regions]);

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
          force_redownload_pbf: forcePbfRedownload,
        }),
      });
      const data = await resp.json();
      if (data.status === 'launched') {
        setSelectedRegion(null);
        fetchProvisionJobs();
      }
    } catch {}
  }, [selectedRegion, selectedProfiles, computeSize, forcePbfRedownload, fetchProvisionJobs]);

  const cancelJob = useCallback(async (region: string) => {
    try {
      await fetch(`/api/regions/${encodeURIComponent(region)}/cancel`, { method: 'POST' });
      fetchProvisionJobs();
    } catch {}
  }, [fetchProvisionJobs]);

  const dismissJob = useCallback(async (jobId: string) => {
    setProvisionJobs((prev) => prev.filter((j) => j.job_id !== jobId));
    try {
      await fetch(`/api/regions/provision/${encodeURIComponent(jobId)}/dismiss`, { method: 'POST' });
    } catch {}
  }, []);

  const askForStatus = useCallback(async (region: string) => {
    setDiagState(prev => ({
      ...prev,
      [region]: { ...(prev[region] || {}), loading: true, expanded: true, error: undefined },
    }));
    try {
      const r = await fetch(`/api/regions/${encodeURIComponent(region)}/diagnose`, { method: 'POST' });
      const d = await r.json();
      if (d.ok) {
        setDiagState(prev => ({
          ...prev,
          [region]: { loading: false, markdown: d.markdown, raw: d.raw_snapshot, expanded: true },
        }));
      } else {
        setDiagState(prev => ({
          ...prev,
          [region]: { loading: false, error: d.error || 'Unknown error', expanded: true },
        }));
      }
    } catch (e: any) {
      setDiagState(prev => ({
        ...prev,
        [region]: { loading: false, error: e.message, expanded: true },
      }));
    }
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

      {health && health.overall !== 'ok' && (
        <div
          role="alert"
          style={{
            background: 'rgba(234,179,8,0.15)',
            border: '1px solid rgba(234,179,8,0.5)',
            color: '#854d0e',
            padding: '0.5rem 0.75rem',
            borderRadius: 6,
            marginBottom: '0.75rem',
            fontSize: 12,
          }}
        >
          <strong>Partial deploy detected.</strong>{' '}
          The following back-end pieces are missing or returned an error; the UI may be falling back to hardcoded defaults:
          <ul style={{ margin: '4px 0 0 16px', padding: 0, listStyle: 'disc' }}>
            {Object.entries(health.status)
              .filter(([, v]) => v !== 'ok')
              .map(([k, v]) => (
                <li key={k}>
                  <code>{k}</code>: {v}
                  {health.errors?.[k] ? ` - ${health.errors[k]}` : ''}
                </li>
              ))}
          </ul>
          <span style={{ fontSize: 11, opacity: 0.85 }}>
            Run <code>scripts/deploy.sh</code> to redeploy the SQL modules and image together.
          </span>
        </div>
      )}

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
                    <button className="btn small" onClick={() => askForStatus(job.region)} style={{ marginLeft: 'auto' }}>
                      {diagState[job.region]?.loading ? 'Asking...' : 'Ask for status'}
                    </button>
                    <button className="btn danger small" onClick={() => cancelJob(job.region)}>Cancel</button>
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
                  {diagState[job.region]?.expanded && (
                    <div style={{
                      marginTop: 8, padding: '10px 12px',
                      background: 'rgba(46, 134, 171, 0.08)',
                      borderLeft: '3px solid var(--accent)',
                      borderRadius: 6, fontSize: 13,
                    }}>
                      {diagState[job.region]?.loading && <div>Diagnosing...</div>}
                      {diagState[job.region]?.error && (
                        <div style={{ color: 'var(--error, #e53935)' }}>Error: {diagState[job.region]?.error}</div>
                      )}
                      {diagState[job.region]?.markdown && (
                        <pre style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word', margin: 0, fontFamily: 'inherit' }}>{diagState[job.region]!.markdown!}</pre>
                      )}
                      {diagState[job.region]?.markdown && (
                        <details style={{ marginTop: 8, fontSize: 11, color: 'var(--text-secondary)' }}>
                          <summary>Raw diagnostic data</summary>
                          <pre style={{ overflow: 'auto', maxHeight: 240 }}>
                            {JSON.stringify(diagState[job.region]?.raw, null, 2)}
                          </pre>
                        </details>
                      )}
                      <button
                        className="btn small ghost"
                        style={{ marginTop: 6 }}
                        onClick={() => setDiagState(prev => ({
                          ...prev,
                          [job.region]: { ...(prev[job.region] || { loading: false, expanded: false }), expanded: false },
                        }))}
                      >
                        Close
                      </button>
                    </div>
                  )}
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

      {buildHistory.length > 0 && (
        <div style={{ marginTop: '1rem' }}>
          <h3 style={{ fontSize: '14px', margin: '0 0 0.5rem' }}>Recent builds</h3>
          <p style={{ fontSize: '11px', opacity: 0.7, margin: '0 0 0.5rem' }}>
            Last {buildHistory.length} build attempts across all regions. Sourced from ORS_BUILD_HISTORY.
          </p>
          <table className="services-table" style={{ fontSize: '12px' }}>
            <thead>
              <tr>
                <th>Region</th>
                <th>Started</th>
                <th>Family / size</th>
                <th>Profiles</th>
                <th>Elapsed</th>
                <th>Status</th>
                <th>Peak RSS</th>
              </tr>
            </thead>
            <tbody>
              {buildHistory.map((b) => {
                const minutes = b.ELAPSED_MINUTES != null ? Math.round(b.ELAPSED_MINUTES * 10) / 10 : null;
                const elapsed = minutes == null
                  ? '\u2014'
                  : minutes >= 60
                    ? `${Math.floor(minutes / 60)}h ${Math.round(minutes % 60)}m`
                    : `${minutes}m`;
                const statusBadge = b.EXIT_STATUS === 'SUCCESS'
                  ? 'ok'
                  : b.EXIT_STATUS === 'IN_PROGRESS'
                    ? 'warn'
                    : 'error';
                return (
                  <tr key={b.BUILD_ID || `${b.REGION}-${b.STARTED_AT}`}>
                    <td>{b.REGION || '\u2014'}</td>
                    <td>{b.STARTED_AT ? new Date(b.STARTED_AT).toLocaleString() : '\u2014'}</td>
                    <td>{b.INSTANCE_FAMILY || '\u2014'}{b.COMPUTE_SIZE ? ` / ${b.COMPUTE_SIZE}` : ''}</td>
                    <td title={b.PROFILES || ''} style={{ maxWidth: 160, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{b.PROFILES || '\u2014'}</td>
                    <td>{elapsed}</td>
                    <td><span className={`badge ${statusBadge}`}>{b.EXIT_STATUS || 'UNKNOWN'}</span></td>
                    <td>{b.PEAK_RSS_GIB != null ? `${Math.round(b.PEAK_RSS_GIB)} GB` : '\u2014'}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
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
                {COMPUTE_SIZES.map((s) => {
                  const isRecommended = s.id === recommendComputeSize(selectedRegion?.level);
                  return (
                    <button
                      key={s.id}
                      className={`btn small${computeSize === s.id ? ' primary' : ''}`}
                      onClick={() => setComputeSize(s.id)}
                      style={{ flex: 1, textAlign: 'center' }}
                      title={s.desc}
                    >
                      <div>
                        <strong>{s.label}</strong>
                        {isRecommended && <span style={{ fontSize: '10px', marginLeft: 6, padding: '1px 6px', borderRadius: 4, background: 'rgba(38, 132, 255, 0.18)', color: '#2684ff' }}>Recommended</span>}
                      </div>
                      <div style={{ fontSize: '11px', opacity: 0.8 }}>{s.vcpu} vCPU / {s.mem}</div>
                      <div style={{ fontSize: '11px', opacity: 0.7 }}>{s.instance} / {s.heap} heap</div>
                    </button>
                  );
                })}
              </div>
              {computeSize === 'XXL' && (
                <p style={{ fontSize: '11px', opacity: 0.7, margin: '0.5rem 0 0' }}>
                  Resolved compute pool: <strong>{largestFamily}</strong>. Graph build runs on the largest high-memory family available in this cloud / region. The runtime service is auto-downsized to a smaller tier after the first successful build (no manual action required).
                </p>
              )}
              {computeSize === 'L' && (
                <p style={{ fontSize: '11px', opacity: 0.7, margin: '0.5rem 0 0' }}>
                  Resolved compute pool: <strong>HIGHMEM_X64_L</strong>. Graph build runs on a 124 vCPU / 984 GB high-memory node. The runtime service is auto-downsized to a smaller tier after the first successful build (no manual action required).
                </p>
              )}
              {/* Advanced override drawer removed: legacy CPU tiers (CPU_X64_SL, CPU_X64_L, HIGHMEM_X64_M) caused OOM-kill loops on country builds; HIGHMEM_X64_L is now the default for country/sub-region via the L tier above. */}
            </div>

            {isRegionProvisioning(selectedRegion.regionKey) && (
              <div className="warning-banner">This region is already being provisioned.</div>
            )}

            <div style={{ marginTop: 16 }}>
              <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginBottom: 6 }}>PBF source</div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                <label style={{ display: 'flex', alignItems: 'flex-start', gap: 8, fontSize: 13, cursor: 'pointer' }}>
                  <input
                    type="radio"
                    name="pbf-source"
                    checked={!forcePbfRedownload}
                    onChange={() => setForcePbfRedownload(false)}
                    style={{ marginTop: 2 }}
                  />
                  <span>
                    <strong>Use cached file if available</strong>
                    <div style={{ fontSize: 11, color: 'var(--text-secondary)' }}>
                      Reuse the .osm.pbf already on the SPCS stage. Multi-GB redeploys complete in seconds.
                    </div>
                  </span>
                </label>
                <label style={{ display: 'flex', alignItems: 'flex-start', gap: 8, fontSize: 13, cursor: 'pointer' }}>
                  <input
                    type="radio"
                    name="pbf-source"
                    checked={forcePbfRedownload}
                    onChange={() => setForcePbfRedownload(true)}
                    style={{ marginTop: 2 }}
                  />
                  <span>
                    <strong>Force re-download from URL</strong>
                    <div style={{ fontSize: 11, color: 'var(--text-secondary)' }}>
                      Pull a fresh copy from Geofabrik / BBBike. Use after a weekly refresh or if cached file is corrupt.
                    </div>
                  </span>
                </label>
              </div>
            </div>
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
                  <button className="btn small" onClick={() => askForStatus(job.region)}>
                    {diagState[job.region]?.loading ? 'Asking...' : 'Ask for status'}
                  </button>
                  <button className="btn small primary" onClick={() => retryJob(job)}>Retry</button>
                  <button className="btn small" onClick={() => dismissJob(job.job_id)}>Dismiss</button>
                </div>
              </div>
              <div style={{ fontSize: 12, color: '#e53935', whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
                {job.error_msg || job.message || 'Unknown error'}
              </div>
              {job.profiles && <div style={{ fontSize: 11, color: 'var(--text-secondary)', marginTop: 4 }}>Profiles: {job.profiles}</div>}
              {diagState[job.region]?.expanded && (
                <div style={{
                  marginTop: 8, padding: '10px 12px',
                  background: 'rgba(46, 134, 171, 0.08)',
                  borderLeft: '3px solid var(--accent)',
                  borderRadius: 6, fontSize: 13,
                }}>
                  {diagState[job.region]?.loading && <div>Diagnosing...</div>}
                  {diagState[job.region]?.error && (
                    <div style={{ color: '#e53935' }}>Error: {diagState[job.region]?.error}</div>
                  )}
                  {diagState[job.region]?.markdown && (
                    <pre style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word', margin: 0, fontFamily: 'inherit' }}>{diagState[job.region]!.markdown!}</pre>
                  )}
                  {diagState[job.region]?.markdown && (
                    <details style={{ marginTop: 8, fontSize: 11, color: 'var(--text-secondary)' }}>
                      <summary>Raw diagnostic data</summary>
                      <pre style={{ overflow: 'auto', maxHeight: 240 }}>
                        {JSON.stringify(diagState[job.region]?.raw, null, 2)}
                      </pre>
                    </details>
                  )}
                  <button
                    className="btn small ghost"
                    style={{ marginTop: 6 }}
                    onClick={() => setDiagState(prev => ({
                      ...prev,
                      [job.region]: { ...(prev[job.region] || { loading: false, expanded: false }), expanded: false },
                    }))}
                  >
                    Close
                  </button>
                </div>
              )}
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
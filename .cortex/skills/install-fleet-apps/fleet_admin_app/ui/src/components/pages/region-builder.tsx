'use client';
import { useCallback, useEffect, useState, useMemo } from 'react';
import type { CatalogRegion } from '@/lib/types';

import {
  ComputeSize, DEFAULT_PROFILES, ProvisionJob, SourceTab, recommendComputeSize,
} from '@/components/region-builder/helpers';
import type { BuildHistoryRow } from '@/components/region-builder/types';
import { useHealthCheck } from '@/components/region-builder/hooks/useHealthCheck';
import { useLargestFamily } from '@/components/region-builder/hooks/useLargestFamily';
import { useRegionsCatalog } from '@/components/region-builder/hooks/useRegionsCatalog';
import { useProvisionJobs } from '@/components/region-builder/hooks/useProvisionJobs';
import { useBuildProgress } from '@/components/region-builder/hooks/useBuildProgress';
import { useBuildHistory } from '@/components/region-builder/hooks/useBuildHistory';
import { useDiagnostics } from '@/components/region-builder/hooks/useDiagnostics';

import HealthBanner from '@/components/region-builder/sections/HealthBanner';
import ActiveJobsTable from '@/components/region-builder/sections/ActiveJobsTable';
import BuildSummaryCard from '@/components/region-builder/sections/BuildSummaryCard';
import ProvisionedRegionsTable from '@/components/region-builder/sections/ProvisionedRegionsTable';
import BuildHistoryTable from '@/components/region-builder/sections/BuildHistoryTable';
import ProvisionForm from '@/components/region-builder/sections/ProvisionForm';
import FailedJobsList from '@/components/region-builder/sections/FailedJobsList';
import CompletedJobsTable from '@/components/region-builder/sections/CompletedJobsTable';

export function RegionBuilderPage() {
  // Provision-form state stays here so build-history "Rerun" can mutate it.
  const [sourceTab, setSourceTab] = useState<SourceTab>('bbbike');
  const [search, setSearch] = useState('');
  const [levelFilter, setLevelFilter] = useState<string>('all');
  const [selectedRegion, setSelectedRegion] = useState<CatalogRegion | null>(null);
  const [selectedProfiles, setSelectedProfiles] = useState<string[]>(DEFAULT_PROFILES);
  const [computeSize, setComputeSize] = useState<ComputeSize>('L');
  const [forcePbfRedownload, setForcePbfRedownload] = useState<boolean>(false);

  const health = useHealthCheck();
  const largestFamily = useLargestFamily();
  const cat = useRegionsCatalog();
  const jobs = useProvisionJobs();
  const buildHistory = useBuildHistory(cat.regions);
  const diag = useDiagnostics();

  const buildingRegions = useMemo(() => {
    const fromJobs = jobs.activeJobs
      .filter((j) => ['building_graph', 'waiting_for_service'].includes(j.stage.toLowerCase()))
      .map((j) => j.region);
    const fromProvisioned = cat.regions
      .filter((r) => r.serviceStatus === 'RUNNING' && !r.isDefault)
      .map((r) => r.region);
    return [...new Set([...fromJobs, ...fromProvisioned])];
  }, [jobs.activeJobs, cat.regions]);

  const buildProgress = useBuildProgress(buildingRegions);

  // While anything is in flight we also want to refresh the regions list so
  // service-status badges update in lockstep with provision-job polling.
  useEffect(() => {
    if (!jobs.hasActiveJobs) return;
    const id = setInterval(() => { cat.fetchRegions(); }, 3000);
    return () => clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [jobs.hasActiveJobs]);

  const toggleProfile = useCallback((profileId: string) => {
    setSelectedProfiles((prev) =>
      prev.includes(profileId) ? prev.filter((p) => p !== profileId) : [...prev, profileId],
    );
  }, []);

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
        jobs.fetchProvisionJobs();
      }
    } catch {}
  }, [selectedRegion, selectedProfiles, computeSize, forcePbfRedownload, jobs]);

  useEffect(() => {
    if (!selectedRegion?.catalogId || selectedRegion.boundaryGeoJson != null) return;
    const { catalogId } = selectedRegion;
    let cancelled = false;
    void cat.fetchCatalogBoundary(catalogId).then((geojson) => {
      if (cancelled || geojson == null) return;
      setSelectedRegion((prev) =>
        prev?.catalogId === catalogId ? { ...prev, boundaryGeoJson: geojson } : prev,
      );
    });
    return () => { cancelled = true; };
  }, [selectedRegion?.catalogId, selectedRegion?.boundaryGeoJson, cat.fetchCatalogBoundary]);

  const retryJob = useCallback((job: ProvisionJob) => {
    const match = cat.catalog.find((r) => r.regionKey.toUpperCase() === job.region.toUpperCase());
    if (match) {
      setSelectedRegion(match);
      const profiles = job.profiles ? job.profiles.split(',').map((p) => p.trim()).filter(Boolean) : DEFAULT_PROFILES;
      setSelectedProfiles(profiles);
      setComputeSize(recommendComputeSize(match.level));
    }
  }, [cat.catalog]);

  const onRerunHistory = useCallback((b: BuildHistoryRow) => {
    if (!b.REGION) return;
    const match = cat.catalog.find((r) => r.regionKey.toUpperCase() === b.REGION!.toUpperCase());
    if (!match) return;
    setSelectedRegion(match);
    const profiles = b.PROFILES
      ? b.PROFILES.split(',').map((p) => p.trim()).filter(Boolean)
      : DEFAULT_PROFILES;
    setSelectedProfiles(profiles);
    if (b.COMPUTE_SIZE === 'S' || b.COMPUTE_SIZE === 'L' || b.COMPUTE_SIZE === 'XXL') {
      setComputeSize(b.COMPUTE_SIZE);
    } else {
      setComputeSize(recommendComputeSize(match.level));
    }
    if (typeof window !== 'undefined') {
      window.scrollTo({ top: document.body.scrollHeight, behavior: 'smooth' });
    }
  }, [cat.catalog]);

  return (
    <div className="panel">
      <h2>Region Builder</h2>
      <p className="subtitle">Deploy per-region ORS instances from OSM map data (Geofabrik + BBBike)</p>

      <HealthBanner health={health} />

      {jobs.activeJobs
        .filter((j) => (j.stage || '').toLowerCase() === 'building_graph')
        .map((j) => (
          <BuildSummaryCard key={`summary-${j.job_id}`} job={j} buildProgress={buildProgress[j.region]} />
        ))}

      <ActiveJobsTable
        jobs={jobs.activeJobs}
        regions={cat.regions}
        buildProgress={buildProgress}
        diagState={diag.diagState}
        onAskForStatus={diag.askForStatus}
        onCancel={jobs.cancelJob}
        onCloseDiag={diag.closeDiag}
      />

      <ProvisionedRegionsTable
        regions={cat.regions}
        loading={cat.regionsLoading}
        onDrop={cat.dropRegion}
      />

      <BuildHistoryTable
        history={buildHistory}
        catalog={cat.catalog}
        onRerun={onRerunHistory}
      />

      <ProvisionForm
        catalog={cat.catalog}
        catalogLoading={cat.catalogLoading}
        refreshing={cat.refreshing}
        onRefreshCatalog={cat.refreshCatalog}
        sourceTab={sourceTab}
        onSourceTabChange={(t) => { setSourceTab(t); setLevelFilter('all'); }}
        search={search}
        onSearchChange={setSearch}
        levelFilter={levelFilter}
        onLevelFilterChange={setLevelFilter}
        selectedRegion={selectedRegion}
        onSelectRegion={(r) => {
          setSelectedRegion(r);
          if (r) {
            setSelectedProfiles(DEFAULT_PROFILES);
            setComputeSize(recommendComputeSize(r.level));
          }
        }}
        selectedProfiles={selectedProfiles}
        onToggleProfile={toggleProfile}
        computeSize={computeSize}
        onComputeSizeChange={setComputeSize}
        forcePbfRedownload={forcePbfRedownload}
        onForcePbfRedownloadChange={setForcePbfRedownload}
        largestFamily={largestFamily}
        isRegionProvisioning={jobs.isRegionProvisioning}
        onDeploy={startProvision}
      />

      <FailedJobsList
        jobs={jobs.failedJobs}
        diagState={diag.diagState}
        onAskForStatus={diag.askForStatus}
        onRetry={retryJob}
        onDismiss={jobs.dismissJob}
        onCloseDiag={diag.closeDiag}
      />

      <CompletedJobsTable
        jobs={jobs.completedJobs}
        onDismiss={jobs.dismissJob}
      />
    </div>
  );
}

// Region-aware endpoint client. Mirrors server/routes/regions/* surface.

import { apiGet, apiPost, apiDelete, regionParam } from './client';
import {
  RegionsListResponse,
  ActiveRegionResponse,
  SetActiveRegionResponse,
  ProvisionedRegionsResponse,
  BuildProgress,
} from './schemas/region';
import {
  HealthStatus,
  LargestFamilyResponse,
  CatalogResponse,
  CatalogRefreshResponse,
  ProvisionedRegionsResponse as ProvisionedRegionsStatusResponse,
  ProvisionStatusResponse,
  ProvisionStartResponse,
  BuildHistoryResponse,
  BuildProgressDetail,
  DiagnoseResponse,
  OkResponse,
} from './schemas/provision';

// GET /api/regions — list every known region (registry + ORS map +
// telemetry-derived). Response includes the currently-active region name.
export function listRegions() {
  return apiGet('/api/regions', RegionsListResponse);
}

// GET /api/regions/active — currently-marked-default region row.
export function getActiveRegion() {
  return apiGet('/api/regions/active', ActiveRegionResponse);
}

// POST /api/regions/active — set the active region. Pass null to opt into
// the gateway DEFAULT_REGION_NAME fallback (server resolves to SanFrancisco).
export function setActiveRegion(region: string | null) {
  return apiPost('/api/regions/active', { region: region ?? '' }, SetActiveRegionResponse);
}

// GET /api/regions/provisioned — only regions whose ORS service is up.
export function listProvisionedRegions() {
  return apiGet('/api/regions/provisioned', ProvisionedRegionsResponse);
}

// GET /api/regions/:region/build-progress — poll graph build phase for a
// region. Pass null for the default region.
export function getBuildProgress(region: string | null) {
  const param = regionParam(region) || 'default';
  return apiGet(`/api/regions/${param}/build-progress`, BuildProgress);
}

// --- RegionBuilder.tsx-specific endpoints (provisioning lifecycle) ---

// GET /api/regions/healthcheck — surfaces missing back-end procs/tables so the
// UI can warn about partial deploys instead of silently using stale defaults.
export function getRegionsHealthcheck() {
  return apiGet('/api/regions/healthcheck', HealthStatus);
}

// GET /api/regions/largest-family — resolves the largest high-memory instance
// family for the XXL banner.
export function getLargestFamily() {
  return apiGet('/api/regions/largest-family', LargestFamilyResponse);
}

// GET /api/regions/catalog — full Geofabrik + BBBike catalog rows.
export function getRegionCatalog() {
  return apiGet('/api/regions/catalog', CatalogResponse);
}

// POST /api/regions/catalog/refresh — repopulates the catalog from upstream.
export function refreshRegionCatalog() {
  return apiPost('/api/regions/catalog/refresh', {}, CatalogRefreshResponse);
}

// GET /api/regions/provisioned (typed status form used by RegionBuilder).
export function getProvisionedRegionsStatus() {
  return apiGet('/api/regions/provisioned', ProvisionedRegionsStatusResponse);
}

// GET /api/regions/provision/status — outstanding + recent provisioning jobs.
export function getProvisionStatus() {
  return apiGet('/api/regions/provision/status', ProvisionStatusResponse);
}

// POST /api/regions/provision — kick off a new provisioning job.
export function startProvision(body: {
  city: string;
  region: string;
  pbf_url: string;
  bbox: { minLat: number; maxLat: number; minLon: number; maxLon: number };
  profiles: string[];
  compute_size: string;
  force_redownload_pbf: boolean;
}) {
  return apiPost('/api/regions/provision', body, ProvisionStartResponse);
}

// POST /api/regions/:region/cancel — cancel the active job for a region.
export function cancelProvision(region: string) {
  return apiPost(`/api/regions/${encodeURIComponent(region)}/cancel`, {}, OkResponse);
}

// POST /api/regions/provision/:jobId/dismiss — remove a finished job from the list.
export function dismissProvisionJob(jobId: string) {
  return apiPost(`/api/regions/provision/${encodeURIComponent(jobId)}/dismiss`, {}, OkResponse);
}

// POST /api/regions/:region/diagnose — run the ask-for-status diagnostic.
export function diagnoseRegion(region: string) {
  return apiPost(`/api/regions/${encodeURIComponent(region)}/diagnose`, {}, DiagnoseResponse);
}

// DELETE /api/regions/:region — drop a provisioned region.
export function dropProvisionedRegion(region: string) {
  return apiDelete(`/api/regions/${encodeURIComponent(region)}`, OkResponse);
}

// GET /api/regions/:region/build-history — build attempts for a region.
export function getRegionBuildHistory(region: string) {
  return apiGet(`/api/regions/${encodeURIComponent(region)}/build-history`, BuildHistoryResponse);
}

// GET /api/regions/:region/build-progress — detailed progress payload (phase,
// percentage, current profile, etc.). Used for the multi-region progress poll.
export function getRegionBuildProgress(region: string) {
  return apiGet(`/api/regions/${encodeURIComponent(region)}/build-progress`, BuildProgressDetail);
}

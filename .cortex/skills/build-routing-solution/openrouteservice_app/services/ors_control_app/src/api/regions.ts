// Region-aware endpoint client. Mirrors server/routes/regions/* surface.

import { apiGet, apiPost, regionParam } from './client';
import {
  RegionsListResponse,
  ActiveRegionResponse,
  SetActiveRegionResponse,
  ProvisionedRegionsResponse,
  BuildProgress,
} from './schemas/region';

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

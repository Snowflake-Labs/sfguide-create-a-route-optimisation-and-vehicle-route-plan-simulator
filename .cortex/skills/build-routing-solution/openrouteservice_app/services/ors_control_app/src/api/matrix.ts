// Typed wrappers for /api/matrix/* endpoints. Mirrors the regions.ts/studio.ts
// pattern: callers pass plain JS objects, get back validated/typed responses.

import { apiGet, apiPost, apiDelete } from './client';
import { StatusOkEnvelope } from './schemas/common';
import {
  MatrixRegionsResponse,
  MatrixStatusResponse,
  MatrixInventoryResponse,
  MatrixBuildRequest,
  MatrixBuildResponse,
  RoadFilterAvailable,
} from './schemas/matrix';

export async function listMatrixRegions() {
  return apiGet('/api/matrix/regions', MatrixRegionsResponse);
}

export async function listMatrixStatus() {
  return apiGet('/api/matrix/status', MatrixStatusResponse);
}

export async function listMatrixInventory() {
  return apiGet('/api/matrix/inventory', MatrixInventoryResponse);
}

export async function isRoadFilterAvailable() {
  return apiGet('/api/matrix/road-filter-available', RoadFilterAvailable);
}

export async function startMatrixBuild(req: MatrixBuildRequest) {
  return apiPost('/api/matrix/build', req, MatrixBuildResponse);
}

export async function deleteMatrix(region: string, profile: string, resolution: string) {
  return apiDelete(
    `/api/matrix/${encodeURIComponent(region)}/${encodeURIComponent(profile)}/${encodeURIComponent(resolution)}`,
    StatusOkEnvelope,
  );
}

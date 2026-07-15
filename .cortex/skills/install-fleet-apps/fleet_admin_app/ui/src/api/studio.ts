// Fleet Data Studio endpoint client. Mirrors server/routes/studio/* surface.

import { apiGet, apiPost, apiDelete } from './client';
import {
  TemplatesResponse,
  PresetsResponse,
  StudioJobsResponse,
  CoverageResponse,
  StatsResponse,
  StudioOrsReadinessResponse,
  GenerateResponse,
  SavePresetResponse,
} from './schemas/studio';
import { OkResponse } from './schemas/provision';

export function getStudioTemplates() {
  return apiGet('/api/studio/templates', TemplatesResponse);
}

export function getStudioPresets() {
  return apiGet('/api/studio/presets', PresetsResponse);
}

export function getStudioJobs() {
  return apiGet('/api/studio/jobs', StudioJobsResponse);
}

export function getStudioStats() {
  return apiGet('/api/studio/stats', StatsResponse);
}

export function getStudioCoverage() {
  return apiGet('/api/studio/coverage', CoverageResponse);
}

export function getOrsReadiness() {
  return apiGet('/api/ors-readiness', StudioOrsReadinessResponse);
}

export function startStudioGeneration(body: unknown) {
  return apiPost('/api/studio/generate', body as object, GenerateResponse);
}

export function cancelStudioJob(jobId: string) {
  return apiPost(`/api/studio/jobs/${encodeURIComponent(jobId)}/cancel`, {}, OkResponse);
}

export function deleteStudioJob(jobId: string) {
  return apiDelete(`/api/studio/jobs/${encodeURIComponent(jobId)}`, OkResponse);
}

export function saveStudioPreset(body: {
  name: string;
  ors_profile: string;
  region: string;
  config: unknown;
}) {
  return apiPost('/api/studio/presets', body, SavePresetResponse);
}

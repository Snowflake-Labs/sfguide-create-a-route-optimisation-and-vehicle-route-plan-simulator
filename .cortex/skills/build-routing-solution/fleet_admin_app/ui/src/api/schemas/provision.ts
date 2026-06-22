// Region provisioning + catalog response shapes used by RegionBuilder.tsx.
// Mirrors server/routes/regions/* surface. Schemas are intentionally permissive
// (.passthrough()) so server payload additions do not break the typed client.

import { z } from 'zod';

export const HealthStatus = z.object({
  overall: z.string(),
  status: z.record(z.string(), z.string()),
  errors: z.record(z.string(), z.string()).optional(),
}).passthrough();

export const LargestFamilyResponse = z.object({
  family: z.string().optional(),
}).passthrough();

export const CatalogRefreshResponse = z.object({}).passthrough();

export const CatalogRow = z.object({}).passthrough();

export const CatalogResponse = z.object({
  catalog: z.array(CatalogRow).optional(),
}).passthrough();

export const ProvisionedRegionStatus = z.object({}).passthrough();

export const ProvisionedRegionsResponse = z.object({
  regions: z.array(ProvisionedRegionStatus).optional(),
}).passthrough();

export const ProvisionJob = z.object({
  job_id: z.string(),
  region: z.string(),
  display_name: z.string().optional(),
  profiles: z.string().optional(),
  status: z.string(),
  stage: z.string().optional(),
  message: z.string().optional(),
  error_msg: z.string().optional(),
  statement_handle: z.string().optional(),
  created_at: z.string().optional(),
  started_at: z.string().optional(),
  completed_at: z.string().optional(),
}).passthrough();

export const ProvisionStatusResponse = z.object({
  jobs: z.array(ProvisionJob).optional(),
}).passthrough();

export const ProvisionStartResponse = z.object({
  status: z.string().optional(),
}).passthrough();

export const BuildHistoryRow = z.object({
  BUILD_ID: z.string().optional(),
  REGION: z.string().optional(),
  INSTANCE_FAMILY: z.string().optional(),
  COMPUTE_SIZE: z.string().optional(),
  PROFILES: z.string().optional(),
  JVM_XMX_GIB: z.number().optional(),
  STARTED_AT: z.string().optional(),
  FINISHED_AT: z.string().optional(),
  ELAPSED_MINUTES: z.number().optional(),
  EXIT_STATUS: z.string().optional(),
  PEAK_RSS_GIB: z.number().nullable().optional(),
  OUTPUT_GRAPH_GIB: z.number().nullable().optional(),
}).passthrough();

export const BuildHistoryResponse = z.object({
  history: z.array(BuildHistoryRow).optional(),
}).passthrough();

export const BuildProgressDetail = z.object({
  phase: z.string(),
  progress: z.number(),
  profileProgress: z.number().optional(),
  nodesRemaining: z.number().optional(),
  nodesTotal: z.number().optional(),
  currentProfile: z.string().nullable().optional(),
  completedProfiles: z.array(z.string()).optional(),
  totalProfiles: z.number().optional(),
  detail: z.string().optional(),
}).passthrough();

export const DiagnoseResponse = z.object({
  ok: z.boolean(),
  markdown: z.string().optional(),
  raw_snapshot: z.unknown().optional(),
  error: z.string().optional(),
}).passthrough();

export const OkResponse = z.object({}).passthrough();

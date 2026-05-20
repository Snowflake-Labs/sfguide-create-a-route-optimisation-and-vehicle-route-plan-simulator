// Matrix endpoint schemas — region listing, build/status/inventory + viewer
// queries. Loose-passthrough on most rows because some optional fields
// (boundaryAreaKm2, road_filter, etc.) appear only conditionally.

import { z } from 'zod';
import { Profile } from './common';

export const MatrixRegion = z.object({
  region: z.string(),
  label: z.string(),
  bounds: z.object({
    minLat: z.number(), maxLat: z.number(),
    minLon: z.number(), maxLon: z.number(),
  }),
  boundaryAreaKm2: z.number().nullable().optional(),
  serviceStatus: z.string(),
  serviceExists: z.boolean(),
  matrixFunctionExists: z.boolean(),
  directionsFunctionExists: z.boolean(),
  ready: z.boolean(),
  provisioned: z.boolean(),
  matrixFn: z.string(),
  labels: z.array(z.string()),
  isDefault: z.boolean().optional(),
}).passthrough();

export const MatrixRegionsResponse = z.object({
  regions: z.array(MatrixRegion),
  error: z.string().optional(),
});

export const MatrixJobStatus = z.object({
  job_id: z.string(),
  region: z.string(),
  profile: z.string(),
  resolution: z.string(),
  status: z.string(),
  stage: z.string(),
  hexagons: z.number(),
  work_queue_rows: z.number(),
  raw_rows: z.number(),
  matrix_rows: z.number(),
  pct_complete: z.number(),
  error_msg: z.string().nullable(),
  statement_handle: z.string().nullable().optional(),
  created_at: z.string().nullable(),
  started_at: z.string().nullable(),
  completed_at: z.string().nullable(),
}).passthrough();

export const MatrixStatusResponse = z.object({
  jobs: z.array(MatrixJobStatus),
  error: z.string().optional(),
});

export const MatrixInventoryItem = z.object({
  region: z.string(),
  table_region: z.string().optional(),
  profile: z.string(),
  resolution: z.string(),
  row_count: z.number(),
  bytes: z.number(),
  created: z.string(),
  table_name: z.string(),
  road_filter: z.boolean().optional(),
}).passthrough();

export const MatrixInventoryResponse = z.object({
  inventory: z.array(MatrixInventoryItem),
  error: z.string().optional(),
});

export const MatrixBuildRequest = z.object({
  region: z.string(),
  resolutions: z.array(z.number()),
  profile: Profile.optional(),
  road_filter: z.boolean().optional(),
  force: z.boolean().optional(),
});

export const MatrixBuildResponse = z.object({
  status: z.string(),
  jobs: z.array(z.object({ job_id: z.string(), resolution: z.number() })),
  warning: z.string().optional(),
  error: z.string().optional(),
}).passthrough();

export const RoadFilterAvailable = z.object({
  available: z.boolean(),
  reason: z.string().optional(),
  detail: z.string().optional(),
});

export const OdPairResponse = z.object({
  found: z.boolean(),
  travel_time_secs: z.number().optional(),
  distance_meters: z.number().optional(),
  origin_lat: z.number().optional(),
  origin_lon: z.number().optional(),
  dest_lat: z.number().optional(),
  dest_lon: z.number().optional(),
  error: z.string().optional(),
});

export const HexLatLonResponse = z.object({
  lat: z.number(),
  lon: z.number(),
  error: z.string().optional(),
});

export type MatrixRegion = z.infer<typeof MatrixRegion>;
export type MatrixJobStatus = z.infer<typeof MatrixJobStatus>;
export type MatrixInventoryItem = z.infer<typeof MatrixInventoryItem>;
export type MatrixBuildRequest = z.infer<typeof MatrixBuildRequest>;

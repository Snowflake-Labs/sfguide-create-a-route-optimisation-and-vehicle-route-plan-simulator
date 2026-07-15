// Region-related response shapes. Mirrors the runtime payloads produced by
// server/routes/regions/lifecycle.ts and server/routes/regions/management.ts.

import { z } from 'zod';
import { Profile } from './common';

// /api/regions returns { regions: RegionInfo[], active: string }
// The server combines REGION_REGISTRY rows with REGION_ORS_MAP and synthetic
// regions, so several columns are nullable.
export const RegionInfo = z.object({
  REGION_NAME: z.string(),
  DISPLAY_NAME: z.string(),
  CENTER_LAT: z.number(),
  CENTER_LON: z.number(),
  BBOX_MIN_LAT: z.number().nullable(),
  BBOX_MAX_LAT: z.number().nullable(),
  BBOX_MIN_LON: z.number().nullable(),
  BBOX_MAX_LON: z.number().nullable(),
  ZOOM_LEVEL: z.number(),
  ORS_REGION_KEY: z.string().nullable(),
  DATA_SOURCE: z.string(),
  IS_DEFAULT: z.union([z.boolean(), z.string()]).optional(),
  BOUNDARY_GEOJSON: z.string().nullable().optional(),
  BOUNDARY_SOURCE: z.string().nullable().optional(),
  BOUNDARY_AREA_KM2: z.number().nullable().optional(),
  BOUNDARY_BAKED_AT: z.string().nullable().optional(),
  BOUNDARY_CENTROID_LON: z.number().nullable().optional(),
  BOUNDARY_CENTROID_LAT: z.number().nullable().optional(),
  ISO_COUNTRY_A2: z.string().nullable().optional(),
  ISO_COUNTRY_A3: z.string().nullable().optional(),
  ISO_SUBDIVISION: z.string().nullable().optional(),
});

export const RegionsListResponse = z.object({
  regions: z.array(RegionInfo),
  active: z.string(),
});

export const ActiveRegionResponse = RegionInfo.partial().extend({
  REGION_NAME: z.string(),
  DISPLAY_NAME: z.string(),
});

export const SetActiveRegionResponse = z.object({
  ok: z.boolean(),
  region: z.string(),
});

export const ProvisionedRegion = z.object({
  region: z.string(),
  display_name: z.string().nullable().optional(),
  profiles_loaded: z.array(Profile),
  center_lat: z.number(),
  center_lon: z.number(),
  zoom: z.number(),
}).passthrough();

export const ProvisionedRegionsResponse = z.object({
  regions: z.array(ProvisionedRegion),
}).passthrough();

export const BuildProgress = z.object({
  status: z.string(),
  phase: z.string().optional(),
  message: z.string().nullable().optional(),
}).passthrough();

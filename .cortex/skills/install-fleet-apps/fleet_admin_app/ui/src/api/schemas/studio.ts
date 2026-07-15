// Studio (Fleet Data Studio) response shapes. Used by FleetDataStudio.tsx hooks.
// Schemas are permissive so server payload tweaks do not break the typed client.

import { z } from 'zod';

export const ProfileTemplate = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string(),
  vehicleType: z.string(),
  orsProfile: z.string(),
  regionScale: z.string(),
  feeds: z.array(z.string()),
  defaultConfig: z.unknown().optional(),
}).passthrough();

export const TemplatesResponse = z.array(ProfileTemplate);

export const Preset = z.object({
  preset_id: z.string(),
  name: z.string(),
  ors_profile: z.string(),
  region: z.string(),
  config: z.unknown().optional(),
  is_builtin: z.boolean().optional(),
}).passthrough();

export const PresetsResponse = z.array(Preset);

export const StudioJobActive = z.object({
  jobId: z.string(),
  presetName: z.string(),
  region: z.string(),
  orsProfile: z.string(),
  vehicleType: z.string(),
  status: z.string(),
  pointsGenerated: z.number().optional(),
  tripsGenerated: z.number().optional(),
  startedAt: z.string().optional(),
}).passthrough();

export const StudioJobsResponse = z.object({
  active: z.array(StudioJobActive).optional(),
  history: z.array(z.unknown()).optional(),
}).passthrough();

export const CoverageEntry = z.object({
  VEHICLE_TYPE: z.string(),
  REGION: z.string(),
  ORS_PROFILE: z.string(),
  TELEMETRY_ROWS: z.number(),
  TRIP_ROWS: z.number(),
  VEHICLES: z.number(),
}).passthrough();

export const CoverageResponse = z.array(CoverageEntry);

export const StatsResponse = z.array(z.unknown());

export const StudioOrsReadinessResponse = z.record(z.string(), z.unknown());

export const GenerateResponse = z.object({
  job_id: z.string().optional(),
  error: z.string().optional(),
}).passthrough();

export const SavePresetResponse = z.object({}).passthrough();

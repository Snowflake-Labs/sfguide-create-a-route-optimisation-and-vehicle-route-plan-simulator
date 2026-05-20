// Pure helpers, types and constants for RegionBuilder.tsx. Co-located so the
// page-level component stays focused on UI orchestration.

import type { CatalogRegion } from '../../types';

export interface PhaseInfo {
  osm: 'done' | 'in_progress' | 'not_started' | 'na';
  lm: 'done' | 'in_progress' | 'not_started' | 'na';
  ch: 'done' | 'in_progress' | 'not_started' | 'na';
}

export interface GraphInfo {
  profile: string;
  ready: boolean;
  build_date?: string | null;
  phases?: PhaseInfo;
}

export interface GraphReadiness {
  service_ready: boolean;
  profiles_loaded: string[];
  expected_profiles: string[];
  graphs: GraphInfo[];
  error?: string;
}

export interface RegionStatus {
  region: string;
  display_name?: string;
  status: string;
  serviceStatus: string;
  pbfDownloaded: boolean;
  functionExists: boolean;
  isDefault?: boolean;
  graphReadiness?: GraphReadiness | null;
}

export interface ProvisionJob {
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

export const PROVISION_PHASES = [
  { id: 'downloading', label: 'Download Map Data' },
  { id: 'configuring', label: 'Write ORS Config' },
  { id: 'starting_service', label: 'Create ORS Service' },
  { id: 'waiting_for_service', label: 'Wait for Service' },
  { id: 'building_graph', label: 'Build Routing Graph' },
];

export const PHASE_ORDER = ['not_started', 'downloading', 'configuring', 'starting_service', 'waiting_for_service', 'building_graph', 'ready'];

export const STEP_GLYPH = { done: '\u2713', active: '\u22EF', pending: '\u25CB' } as const;

export type StepState = 'done' | 'active' | 'pending';

export const ALL_PROFILES: { id: string; label: string; group: string }[] = [
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

export const DEFAULT_PROFILES = ['driving-car', 'driving-hgv', 'cycling-electric'];

export type ComputeSize = 'S' | 'L' | 'XXL';

export const COMPUTE_SIZES: { id: ComputeSize; label: string; instance: string; vcpu: number; mem: string; heap: string; desc: string }[] = [
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
export function recommendComputeSize(level: string | undefined): ComputeSize {
  if (level === 'city') return 'S';
  if (level === 'country' || level === 'sub-region') return 'L';
  return 'XXL';
}

export type SourceTab = 'bbbike' | 'geofabrik';

export function sizeLabel(mb: number | undefined | null): string {
  if (mb == null) return '—';
  if (mb >= 1024) return `${(mb / 1024).toFixed(1)} GB`;
  return `${Math.round(mb)} MB`;
}

export function sizeClass(mb: number | undefined | null): string {
  if (mb == null) return '';
  if (mb < 100) return 'size-small';
  if (mb < 500) return 'size-medium';
  if (mb < 2048) return 'size-large';
  return 'size-xlarge';
}

export function estTime(mb: number | undefined | null): string {
  if (mb == null) return '—';
  if (mb < 100) return '~5 min';
  if (mb < 500) return '~10-30 min';
  if (mb < 2048) return '~30-60 min';
  return '1+ hours';
}

export function toCatalogRegion(row: any): CatalogRegion {
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

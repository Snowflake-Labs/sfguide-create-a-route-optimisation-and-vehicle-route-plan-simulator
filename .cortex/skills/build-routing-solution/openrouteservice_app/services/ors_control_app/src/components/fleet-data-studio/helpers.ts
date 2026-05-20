// Pure types and constants for FleetDataStudio.tsx.

import { CarTaxiFront, Bike, Truck } from 'lucide-react';

export interface Preset {
  preset_id: string;
  name: string;
  ors_profile: string;
  region: string;
  config: any;
  is_builtin: boolean;
}

export interface ProfileTemplate {
  id: string;
  name: string;
  description: string;
  vehicleType: string;
  orsProfile: string;
  regionScale: string;
  feeds: string[];
  defaultConfig: any;
}

export interface JobInfo {
  jobId: string;
  presetName: string;
  region: string;
  orsProfile: string;
  vehicleType: string;
  status: string;
  pointsGenerated: number;
  tripsGenerated: number;
  startedAt: string;
}

export interface CoverageEntry {
  VEHICLE_TYPE: string;
  REGION: string;
  ORS_PROFILE: string;
  TELEMETRY_ROWS: number;
  TRIP_ROWS: number;
  VEHICLES: number;
}

export const VEHICLE_ICONS: Record<string, any> = {
  car: CarTaxiFront,
  ebike: Bike,
  hgv: Truck,
};

export const VEHICLE_COLORS: Record<string, string> = {
  car: '#29B5E8',
  ebike: '#4CAF50',
  hgv: '#FF9800',
};

export const VEHICLE_LABELS: Record<string, string> = {
  car: 'City Taxis',
  ebike: 'E-Bike Couriers',
  hgv: 'HGV Logistics',
};

export const SKILL_MAP: Record<string, string> = {
  'dwell-analysis': 'Dwell Analysis',
  'fleet-intelligence-taxis': 'Fleet Taxis',
  'fleet-intelligence-food-delivery': 'Food Delivery',
  'route-deviation': 'Route Deviation',
};

export const PIE_COLORS = ['#29B5E8', '#4CAF50', '#FF9800', '#E91E63', '#9C27B0'];

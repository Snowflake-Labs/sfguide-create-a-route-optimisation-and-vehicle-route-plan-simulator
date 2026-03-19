export interface ServiceInfo {
  name: string;
  status: string;
}

export interface StatusResponse {
  compute_pool: string;
  services: ServiceInfo[];
}

export interface CityConfig {
  region: string;
  display_name: string;
  status: string;
  bbox: { min_lat: number; max_lat: number; min_lon: number; max_lon: number };
}

export interface RegionInfo {
  region: string;
  label: string;
  bounds: { minLat: number; maxLat: number; minLon: number; maxLon: number };
  serviceStatus: string;
  serviceExists: boolean;
  matrixFunctionExists: boolean;
  directionsFunctionExists: boolean;
  ready: boolean;
  provisioned: boolean;
  matrixFn: string;
  cities: string[];
}

export interface MatrixBuildStatus {
  region: string;
  resolution: number;
  status: string;
  stage: string;
  total_origins: number;
  processed_origins: number;
  total_pairs: number;
  built_pairs: number;
  percent_complete: number;
  elapsed_seconds: number;
  est_remaining_seconds: number;
  hexagons: number;
  work_queue: number;
  raw_ingested: number;
  flattened: number;
  error?: string;
}

export interface MatrixEstimate {
  region: string;
  resolutions: {
    res: number;
    label: string;
    hexagons: number;
    cutoff_miles: number;
    sparse_pairs: number;
    est_time_minutes: number;
    est_credits: number;
  }[];
  total_pairs: number;
  total_time_minutes: number;
  total_credits: number;
  snowflake_cost: number;
  api_comparison: { provider: string; cost_per_call: number; calls_needed: number; total_cost: number }[];
}

export interface FunctionTestResult {
  success: boolean;
  result?: any;
  error?: string;
  duration_ms: number;
}

export const CITY_CATALOG: Record<string, { region: string; pbfUrl: string; bbox: { minLat: number; maxLat: number; minLon: number; maxLon: number } }> = {
  'San Francisco': { region: 'SanFrancisco', pbfUrl: 'https://download.bbbike.org/osm/bbbike/SanFrancisco/SanFrancisco.osm.pbf', bbox: { minLat: 37.71, maxLat: 37.81, minLon: -122.51, maxLon: -122.37 } },
  'New York': { region: 'NewYork', pbfUrl: 'https://download.bbbike.org/osm/bbbike/NewYork/NewYork.osm.pbf', bbox: { minLat: 40.49, maxLat: 40.92, minLon: -74.26, maxLon: -73.70 } },
  'London': { region: 'London', pbfUrl: 'https://download.bbbike.org/osm/bbbike/London/London.osm.pbf', bbox: { minLat: 51.28, maxLat: 51.69, minLon: -0.51, maxLon: 0.33 } },
  'Paris': { region: 'Paris', pbfUrl: 'https://download.bbbike.org/osm/bbbike/Paris/Paris.osm.pbf', bbox: { minLat: 48.81, maxLat: 48.90, minLon: 2.22, maxLon: 2.47 } },
  'Berlin': { region: 'Berlin', pbfUrl: 'https://download.bbbike.org/osm/bbbike/Berlin/Berlin.osm.pbf', bbox: { minLat: 52.34, maxLat: 52.68, minLon: 13.09, maxLon: 13.76 } },
  'Chicago': { region: 'Chicago', pbfUrl: 'https://download.bbbike.org/osm/bbbike/Chicago/Chicago.osm.pbf', bbox: { minLat: 41.64, maxLat: 42.02, minLon: -87.94, maxLon: -87.52 } },
  'Los Angeles': { region: 'LosAngeles', pbfUrl: 'https://download.bbbike.org/osm/bbbike/LosAngeles/LosAngeles.osm.pbf', bbox: { minLat: 33.70, maxLat: 34.34, minLon: -118.67, maxLon: -117.65 } },
  'San Jose': { region: 'SanJose', pbfUrl: 'https://download.bbbike.org/osm/bbbike/SanJose/SanJose.osm.pbf', bbox: { minLat: 37.12, maxLat: 37.47, minLon: -122.05, maxLon: -121.72 } },
  'Sacramento': { region: 'Sacramento', pbfUrl: 'https://download.bbbike.org/osm/bbbike/Sacramento/Sacramento.osm.pbf', bbox: { minLat: 38.43, maxLat: 38.70, minLon: -121.56, maxLon: -121.35 } },
};

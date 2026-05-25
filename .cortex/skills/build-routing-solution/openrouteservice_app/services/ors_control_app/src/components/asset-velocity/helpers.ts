// Helpers, types, and constants for AssetVelocity (smart reposition v1.1).

import { TileLayer } from '@deck.gl/geo-layers';
import { BitmapLayer } from '@deck.gl/layers';

// sfQuery + asSqlJsonLiteral live in the shared src/lib/sfQuery module so all
// pages share the same body.error handling and dollar-quoted JSON escape path.
// We re-export here to keep the existing import sites in this folder stable.
import { sfQuery as sharedSfQuery, asSqlJsonLiteral, safeText, type SfQueryOpts } from '../../lib/sfQuery';
export { asSqlJsonLiteral, safeText };
export type { SfQueryOpts };

export const RO_DB = 'FLEET_INTELLIGENCE';
export const RO_SCHEMA = 'ROUTE_OPTIMIZATION';
export const CARTO_LIGHT = '/api/tiles/{z}/{x}/{y}';

export async function sfQuery(
  sql: string,
  database = RO_DB,
  schema = RO_SCHEMA,
  opts: SfQueryOpts = {},
): Promise<any[]> {
  return sharedSfQuery(sql, database, schema, opts);
}

export function cartoBasemap() {
  return new TileLayer({
    id: 'carto-basemap', data: CARTO_LIGHT, minZoom: 0, maxZoom: 19, tileSize: 256,
    renderSubLayers: (props: any) => {
      const { boundingBox } = props.tile;
      return new BitmapLayer(props, { data: undefined, image: props.data, bounds: [boundingBox[0][0], boundingBox[0][1], boundingBox[1][0], boundingBox[1][1]] });
    },
  });
}

export const SEVERITY_COLOR: Record<string, [number, number, number]> = {
  CRITICAL: [220, 38, 38],
  WARNING: [245, 158, 11],
  WATCH: [251, 191, 36],
  OK: [34, 197, 94],
};

export type VehicleSubtype = 'DRY' | 'REEFER' | 'FLAT' | 'TANKER' | null;

export interface Trailer {
  VEHICLE_ID: string;
  REGION: string;
  LAST_LOCATION_NAME: string;
  LAST_LOCATION_TYPE: string;
  LAST_LNG: number;
  LAST_LAT: number;
  IDLE_SINCE: string;
  IDLE_HOURS: number;
  IDLE_DAYS: number;
  ASSIGNED_DISPATCHER: string;
  COST_OF_IDLENESS_USD: number;
  PROJECTED_SAVINGS_USD: number;
  IDLE_SEVERITY: string;
  // v1.1 HGV profile (may be NULL for non-trucking presets)
  VEHICLE_SUBTYPE?: VehicleSubtype;
  HAZMAT?: boolean;
  WEIGHT_TONS?: number;
  HEIGHT_M?: number;
  LENGTH_M?: number;
  WIDTH_M?: number;
  AXLELOAD_T?: number;
  ORS_PROFILE?: string;
  // v1.1 page config (same on every row, materialised here for convenience)
  MAX_REPOSITION_MINUTES?: number;
  AVOID_FEATURES?: string;
}

export interface Terminal {
  TERMINAL_ID: string;
  TERMINAL_NAME: string;
  LOCATION_TYPE: string;
  TERMINAL_LAT: number;
  TERMINAL_LNG: number;
  OUTBOUND: number;
  INBOUND: number;
  NET_OUTBOUND_TRIPS: number;
  DEMAND_SCORE: number;
}

// Reason codes shown for excluded terminals in the action-alerts table.
export type ExclusionReason =
  | 'OUT_OF_SHIFT'         // road duration > MAX_REPOSITION_MINUTES
  | 'NOT_ROUTABLE'         // ORS could not snap / unreachable in current graph
  | 'INCOMPATIBLE_SKILL'   // trailer subtype cannot serve terminal lane mix
  | 'NO_DEMAND';           // terminal has no positive net-outbound (filtered upstream)

export interface ReachabilityCell {
  durationSec: number | null;   // null = not routable
  distanceM: number | null;
  reachable: boolean;           // true when durationSec <= MAX_REPOSITION_MINUTES * 60
}

// MatrixCache[trailerId][terminalId] = ReachabilityCell
export type MatrixCache = Record<string, Record<string, ReachabilityCell>>;

export interface VrpResult {
  warning?: string;
  routesCount?: number;
  unassignedCount?: number;
  totalDurationSec?: number;
}

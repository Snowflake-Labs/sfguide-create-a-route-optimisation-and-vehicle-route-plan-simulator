// Helpers, types, and constants for AssetVelocity.

import { TileLayer } from '@deck.gl/geo-layers';
import { BitmapLayer } from '@deck.gl/layers';

export const RO_DB = 'FLEET_INTELLIGENCE';
export const RO_SCHEMA = 'ROUTE_OPTIMIZATION';
export const CARTO_LIGHT = '/api/tiles/{z}/{x}/{y}';

export async function sfQuery(sql: string, database = RO_DB, schema = RO_SCHEMA): Promise<any[]> {
  try {
    const res = await fetch('/api/query', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sql, database, schema }) });
    const body = await res.json();
    const rows = Array.isArray(body) ? body : (body.result ?? []);
    return Array.isArray(rows) ? rows : [];
  } catch (err) {
    console.error('[sfQuery] Error:', err, 'SQL:', sql.slice(0, 300));
    return [];
  }
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

// Render helpers + small pure functions shared across Freight Exchange
// sub-components. No state, no side effects.

import { TileLayer } from '@deck.gl/geo-layers';
import { BitmapLayer } from '@deck.gl/layers';
import type { Offer } from './types';

// Carto basemap layer used by OffersMap. Centralised here so future map
// surfaces (round-trip overlay, isochrone polygon, lane-density heatmap)
// import the same tile source.
export function cartoBasemap() {
  return new TileLayer({
    id: 'carto-basemap',
    data: '/api/tiles/{z}/{x}/{y}',
    minZoom: 0,
    maxZoom: 19,
    tileSize: 256,
    renderSubLayers: (props: any) => {
      const { boundingBox } = props.tile;
      return new BitmapLayer(props, {
        data: undefined,
        image: props.data,
        bounds: [boundingBox[0][0], boundingBox[0][1], boundingBox[1][0], boundingBox[1][1]],
      });
    },
  });
}

// Trust badge cell renderer (Phase B).
export function renderTrust(b: Offer['TRUST_BADGE']) {
  if (b === 'GREEN') return <span style={{ color: '#16a34a', fontWeight: 600 }}>● Verified</span>;
  if (b === 'YELLOW') return <span style={{ color: '#ca8a04', fontWeight: 600 }}>● Caution</span>;
  if (b === 'RED') return <span style={{ color: '#dc2626', fontWeight: 600 }}>● Risk</span>;
  return <span style={{ color: '#6b7280' }}>—</span>;
}

// Market-rate badge cell renderer (Phase B).
export function renderMarket(o: Offer) {
  if (o.MARKET_BADGE === 'UNKNOWN' || o.PRICE_DELTA_PCT === null) {
    return <span style={{ color: '#6b7280' }}>—</span>;
  }
  const pct = o.PRICE_DELTA_PCT;
  const style: React.CSSProperties = { fontWeight: 600 };
  if (o.MARKET_BADGE === 'BELOW_MARKET') style.color = '#16a34a';
  else if (o.MARKET_BADGE === 'ABOVE_MARKET') style.color = '#dc2626';
  else style.color = '#0369a1';
  const sign = pct > 0 ? '+' : '';
  return <span style={style}>{sign}{pct.toFixed(1)}%</span>;
}

// Detour badge cell renderer (Phase E1, used by RoutePanel + grid).
export function renderDetour(b: Offer['ROUTE_DETOUR_BADGE']) {
  if (!b || b === 'PENDING_ROUTE') return <span style={{ color: '#6b7280' }}>—</span>;
  if (b === 'DIRECT') return <span style={{ color: '#16a34a', fontWeight: 600 }}>● Direct</span>;
  if (b === 'DETOUR_MODERATE') return <span style={{ color: '#ca8a04', fontWeight: 600 }}>● Detour</span>;
  return <span style={{ color: '#dc2626', fontWeight: 600 }}>● Heavy</span>;
}

// ROAD_MIN -> "3h 20m" / "45m"
export function formatDuration(min: number | null | undefined): string {
  if (min == null || !Number.isFinite(min)) return '—';
  if (min < 60) return `${Math.round(min)}m`;
  const h = Math.floor(min / 60);
  const m = Math.round(min - h * 60);
  return m === 0 ? `${h}h` : `${h}h ${m}m`;
}

// Parse a ROUTE_GEOMETRY string (GeoJSON LineString JSON) into a coordinate
// array suitable for deck.gl PathLayer. Returns null on parse failure.
export function parseRouteGeometry(geom: string | null | undefined): [number, number][] | null {
  if (!geom) return null;
  try {
    const parsed = typeof geom === 'string' ? JSON.parse(geom) : geom;
    if (parsed?.type === 'LineString' && Array.isArray(parsed.coordinates)) {
      return parsed.coordinates as [number, number][];
    }
    if (Array.isArray(parsed)) return parsed as [number, number][];
    return null;
  } catch {
    return null;
  }
}

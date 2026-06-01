// Static labels, colour palette, sort ranks, and CSS for the Freight Exchange
// page. Pulled out of FreightExchange.tsx so future enrichment files can
// import the same palette without duplicating literals.

import type { CSSProperties } from 'react';

export const FX_DB = 'FLEET_INTELLIGENCE';
export const FX_SCHEMA = 'MARKETPLACE';

export const ALL_SOURCES_EU = ['TIMOCOM', 'WTRANSNET', 'TELEROUTE', 'B2P'];
export const ALL_SOURCES_NA = ['DAT', 'TRUCKSTOP', 'CONVOY', 'UBER_FREIGHT'];
export const EQUIPMENTS = ['TAUTLINER', 'MEGA', 'REEFER', 'BOX', 'FLATBED'];

export const SOURCE_COLOR: Record<string, [number, number, number]> = {
  TIMOCOM: [255, 122, 0],
  WTRANSNET: [0, 122, 255],
  TELEROUTE: [255, 200, 0],
  B2P: [180, 0, 200],
  DAT: [255, 100, 100],
  TRUCKSTOP: [100, 200, 100],
  CONVOY: [120, 120, 220],
  UBER_FREIGHT: [40, 40, 40],
};

export const TRUST_RANK: Record<string, number> = { GREEN: 1, YELLOW: 2, RED: 3 };
export const MARKET_RANK: Record<string, number> = {
  BELOW_MARKET: 1, AT_MARKET: 2, ABOVE_MARKET: 3, UNKNOWN: 4,
};

export const thStyle: CSSProperties = {
  padding: '6px 8px', textAlign: 'left',
  borderBottom: '1px solid #e5e7eb',
  background: '#f9fafb', fontSize: 11, color: '#374151',
};
export const tdStyle: CSSProperties = {
  padding: '5px 8px', whiteSpace: 'nowrap',
};
export const tdNum: CSSProperties = {
  ...tdStyle, textAlign: 'right', fontVariantNumeric: 'tabular-nums',
};

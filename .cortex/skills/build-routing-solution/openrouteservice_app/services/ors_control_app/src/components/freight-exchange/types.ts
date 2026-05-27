// Shared types for the Freight Exchange page and its sub-components.
// Phase A + B fields are required; Phase E1-E8 enrichment fields are optional
// so the same types work against deployments that haven't yet shipped
// VW_OFFER_ENRICHED_V2.

export interface Offer {
  OFFER_ID: string;
  SOURCE: string;
  PARTNER_ID: string;
  PARTNER_NAME: string | null;
  PARTNER_COUNTRY: string | null;
  PARTNER_CREDIT_SCORE: number | null;
  PARTNER_PAYMENT_DAYS: number | null;
  PARTNER_KYC: string | null;
  PARTNER_BLACKLIST: boolean | null;
  TRUST_BADGE: 'GREEN' | 'YELLOW' | 'RED' | null;
  PICKUP_CITY: string;
  PICKUP_LON: number;
  PICKUP_LAT: number;
  DROPOFF_CITY: string;
  DROPOFF_LON: number;
  DROPOFF_LAT: number;
  WEIGHT_KG: number;
  PRODUCT: string;
  PRICE_USD: number;
  HAZMAT: boolean;
  EQUIPMENT: string | null;
  ADR_CLASS: string | null;
  LDM: number | null;
  DISTANCE_KM: number | null;
  PRICE_PER_KM_USD: number | null;
  STATUS: string;
  POSTED_AGE_MIN: number;
  MARKET_P25: number | null;
  MARKET_P50: number | null;
  MARKET_P75: number | null;
  PRICE_DELTA_PCT: number | null;
  MARKET_BADGE: 'UNKNOWN' | 'AT_MARKET' | 'BELOW_MARKET' | 'ABOVE_MARKET';
  // Phase E1 enrichment (VW_OFFER_ENRICHED_V2). Optional — populated only when
  // FACT_OFFER_ROUTES has a row for this OFFER_ID.
  ROAD_KM?: number | null;
  ROAD_MIN?: number | null;
  ROUTE_GEOMETRY?: string | null;
  ROUTE_DETOUR_BADGE?: 'PENDING_ROUTE' | 'DIRECT' | 'DETOUR_MODERATE' | 'DETOUR_HEAVY' | null;
  PRICE_PER_ROAD_KM_USD?: number | null;
}

export interface LaneRow {
  PARTNER_ID: string;
  ORIGIN_COUNTRY: string;
  DEST_COUNTRY: string;
  EQUIPMENT: string;
  SHIPMENTS: number;
  ON_TIME: number;
  LATE_CNT: number;
  DAMAGED_CNT: number;
  AVG_EUR_PER_KM: number;
}

// Trailers come from BACKLOAD_MATCHING.VW_TRAILERS. Used by the trailer-picker
// dropdown (added in a later enrichment turn).
export interface Trailer {
  TRAILER_ID: string;
  DROPOFF_CITY: string | null;
  DROPOFF_LON: number;
  DROPOFF_LAT: number;
  HOME_LON: number | null;
  HOME_LAT: number | null;
  ETA_MIN: number | null;
}

export type SortKey =
  | 'SOURCE' | 'PICKUP_CITY' | 'DROPOFF_CITY' | 'EQUIPMENT'
  | 'WEIGHT_KG' | 'PRICE_USD' | 'PRICE_PER_KM_USD' | 'DISTANCE_KM'
  | 'POSTED_AGE_MIN' | 'TRUST_BADGE' | 'MARKET_BADGE' | 'STATUS';

export type SortDir = 'asc' | 'desc';

// Filter state passed between the orchestrator and FilterBar.
export interface FilterState {
  sourcesEnabled: Record<string, boolean>;
  equipEnabled: Record<string, boolean>;
  adrOnly: 'any' | 'adr' | 'no_adr';
  statusFilter: 'OPEN' | 'ALL';
  usdPerKmMin: number | '';
  usdPerKmMax: number | '';
  maxAgeMin: number;
  trustFilter: 'ANY' | 'GREEN' | 'GREEN_OR_YELLOW';
}

// Result envelopes for forthcoming /api/fx/* endpoints (E4/E5/E8).
// Bodies will be filled in by api.ts in a later enrichment turn.
export interface RoundTripResult {
  vrp: any;
  primary: Offer;
  candidates: Offer[];
}
export interface BundleResult {
  vrp: any;
  eu561Compliant: boolean;
  offers: Offer[];
}
export interface DraftResult {
  draft: string;
  suggestedUsd: number | null;
  context: any;
}

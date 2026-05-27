// Typed fetch wrappers for the Freight Exchange /api/fx/* endpoints.
// The endpoints already exist in services/ors_control_app/server/routes/freight_exchange.ts.
// Each function below mirrors one endpoint; bodies are minimal so future
// enrichment turns add a single function here + one import in a panel.

import type { RoundTripResult, BundleResult, DraftResult } from './types';

async function postJson<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`${path} -> ${res.status}`);
  return res.json() as Promise<T>;
}

async function getJson<T>(path: string): Promise<T> {
  const res = await fetch(path);
  if (!res.ok) throw new Error(`${path} -> ${res.status}`);
  return res.json() as Promise<T>;
}

// Phase E1
export const postRefreshRoutes = (body: { batchSize?: number; maxAgeHours?: number; vehicleType?: string }) =>
  postJson<{ processed: number; failed: number }>('/api/fx/refresh-routes', body);

export const postEta = (body: { trailerLon: number; trailerLat: number; offerId: string; vehicleType?: string }) =>
  postJson<{ offerId: string; roadKm: number | null; roadMin: number | null; geometry: any }>('/api/fx/eta', body);

// Pickup -> Dropoff route for the selected offer (used by the map to show
// origin, destination, and travel path under the active region/preset).
export const postOfferRoute = (body: { offerId: string; vehicleType?: string }) =>
  postJson<{ offerId: string; roadKm: number | null; roadMin: number | null; geometry: any; region: string; profile: string }>('/api/fx/offer-route', body);

// Phase E2
export const postIsochrone = (body: { trailerLon: number; trailerLat: number; rangeSeconds?: number; vehicleType?: string }) =>
  postJson<{ isochrone: any; rangeSeconds: number; profile: string }>('/api/fx/isochrone', body);

// Phase E3
export const getDeadhead = () =>
  getJson<{ rows: Array<{ OFFER_ID: string; BEST_TRAILER_ID: string | null; BEST_DEADHEAD_KM: number | null }> }>('/api/fx/deadhead');

export const postRefreshDeadhead = (body: { topNTrailers?: number; topNOffers?: number; vehicleType?: string }) =>
  postJson<{ trailers: number; offers: number; matrix: number }>('/api/fx/refresh-deadhead', body);

// Phase E4
export const postRoundTrip = (body: { trailerId: string; offerId: string; returnCandidateIds?: string[]; vehicleType?: string }) =>
  postJson<RoundTripResult>('/api/fx/round-trip', body);

// Phase E5
export const postBundle = (body: { trailerId: string; offerIds: string[]; vehicleType?: string }) =>
  postJson<BundleResult>('/api/fx/bundle', body);

// Phase E7
export const getLaneDensity = () =>
  getJson<{ cells: Array<{ H3_CELL: string; EQUIPMENT: string; SHIPMENT_COUNT: number }> }>('/api/fx/lane-density');

// Phase E8
export const postDraftCounter = (body: { offerId: string; dispatcherId?: string }) =>
  postJson<DraftResult>('/api/fx/draft-counter', body);

// Shared audit
export const postDecision = (body: {
  trailerId?: string; offerId?: string; bundleId?: string;
  decisionType: 'SINGLE' | 'ROUND_TRIP' | 'BUNDLE';
  score?: number; emptyKm?: number; netBenefitEur?: number;
  decidedBy?: string; rationale?: string;
}) => postJson<{ ok: boolean }>('/api/fx/decisions', body);

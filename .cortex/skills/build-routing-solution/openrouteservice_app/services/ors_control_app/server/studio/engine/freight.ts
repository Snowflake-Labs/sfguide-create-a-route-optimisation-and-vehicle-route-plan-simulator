// Synthetic freight-offer generator. Self-contained — depends only on POIs,
// GenerationConfig, and the deterministic RNG from profiles.

import { GenerationConfig, createRng } from '../profiles.js';
import { POI, FreightOffer } from './types.js';

function sourceLabelsForRegion(region: string): string[] {
  const r = (region || '').toLowerCase();
  if (r.includes('germany') || r.includes('europe') || r.includes('netherlands') || r.includes('france') || r.includes('italy') || r.includes('spain')) {
    return ['TIMOCOM', 'WTRANSNET', 'TELEROUTE', 'B2P'];
  }
  return ['DAT', 'TRUCKSTOP', 'CONVOY', 'UBER_FREIGHT'];
}

const FREIGHT_PRODUCTS = [
  'Pallets (general)', 'Steel coils', 'Plastic granulate',
  'Beverages', 'Furniture', 'Bulk paper',
];

export function generateFreightOffers(pois: POI[], config: GenerationConfig, n = 300): FreightOffer[] {
  if (!pois || pois.length < 2) return [];
  const rng = createRng((config.region || '').length * 1009 + (config.ors_profile || '').length * 17);
  const sources = sourceLabelsForRegion(config.region);
  const offers: FreightOffer[] = [];
  let safety = 0;
  while (offers.length < n && safety < n * 5) {
    safety++;
    const pIdx = Math.floor(rng() * pois.length);
    const dIdx = Math.floor(rng() * pois.length);
    if (pIdx === dIdx) continue;
    const p = pois[pIdx];
    const d = pois[dIdx];
    const wt = 800 + Math.floor(rng() * 24200);
    const price = 400 + Math.floor(rng() * 4100);
    const haz = rng() < 0.08;
    const winStart = 60 + Math.floor(rng() * 1140);
    const winLen = 60 + Math.floor(rng() * 420);
    const src = sources[offers.length % sources.length];
    const product = FREIGHT_PRODUCTS[offers.length % FREIGHT_PRODUCTS.length];
    offers.push({
      offer_id: `OFF-${String(offers.length + 1).padStart(6, '0')}`,
      source: src,
      product,
      pickup_poi_id: p.location_id,
      pickup_lat: p.lat,
      pickup_lon: p.lng,
      dropoff_poi_id: d.location_id,
      dropoff_lat: d.lat,
      dropoff_lon: d.lng,
      weight_kg: wt,
      price_usd: price,
      hazmat: haz,
      pickup_from_offset_min: winStart,
      pickup_to_offset_min: winStart + winLen,
      listing_text: `${src} ${p.name} -> ${d.name} ${wt} kg ${product} ${price}${haz ? ' ADR' : ''}`,
    });
  }
  return offers;
}

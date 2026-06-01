// Synthetic freight-offer generator. Self-contained — depends only on POIs,
// GenerationConfig, and the deterministic RNG from profiles. Enriched with
// equipment / ADR class / LDM / EUR-per-km / partner_id / status / posted_at
// columns to power the Freight Exchange page filters and badges.

import { GenerationConfig, createRng } from '../profiles.js';
import { POI, FreightOffer, Partner } from './types.js';

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

const EQUIPMENTS = ['TAUTLINER', 'MEGA', 'REEFER', 'BOX', 'FLATBED'];
const ADR_CLASSES = ['1', '2', '3', '4.1', '5.1', '6.1', '8', '9'];

function haversineKm(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 6371;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLon = ((lon2 - lon1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) * Math.cos((lat2 * Math.PI) / 180) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

export function generateFreightOffers(
  pois: POI[],
  config: GenerationConfig,
  n = 300,
  partners: Partner[] = [],
): FreightOffer[] {
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
    const distanceKm = Math.max(5, haversineKm(p.lat, p.lng, d.lat, d.lng));
    const equipment = EQUIPMENTS[Math.floor(rng() * EQUIPMENTS.length)];
    const haz = rng() < 0.08;
    const adrClass = haz ? ADR_CLASSES[Math.floor(rng() * ADR_CLASSES.length)] : null;
    const ldm = Math.round((1 + rng() * 12.5) * 10) / 10;
    // Base USD/km swings around an equipment-aware market mean with a noise
    // term so RATE_INDEX has meaningful p25/p50/p75 spread.
    const baseRate = equipment === 'REEFER' ? 1.55 : equipment === 'MEGA' ? 1.40 : equipment === 'FLATBED' ? 1.35 : 1.20;
    const eurPerKm = Math.max(0.7, baseRate + (rng() - 0.5) * 0.55);
    const price = Math.max(120, Math.round(eurPerKm * distanceKm));
    const winStart = 60 + Math.floor(rng() * 1140);
    const winLen = 60 + Math.floor(rng() * 420);
    const src = sources[offers.length % sources.length];
    const product = FREIGHT_PRODUCTS[offers.length % FREIGHT_PRODUCTS.length];
    // Status: ~78% OPEN, 17% TAKEN, 5% EXPIRED — gives the page a live feel.
    const sRoll = rng();
    const status = sRoll < 0.78 ? 'OPEN' : sRoll < 0.95 ? 'TAKEN' : 'EXPIRED';
    // Posted within the last 24h, weighted toward more recent.
    const ageMin = -Math.floor(Math.pow(rng(), 1.6) * 1440);
    const partner = partners.length > 0 ? partners[Math.floor(rng() * partners.length)] : null;
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
      listing_text: `${src} ${p.name} -> ${d.name} ${wt} kg ${product} ${price}${haz ? ` ADR ${adrClass}` : ''} ${equipment}`,
      equipment,
      adr_class: adrClass,
      ldm,
      distance_km: Math.round(distanceKm * 10) / 10,
      price_per_km_usd: Math.round(eurPerKm * 100) / 100,
      partner_id: partner ? partner.partner_id : 'P-UNKNOWN',
      status,
      posted_at_offset_min: ageMin,
    });
  }
  return offers;
}

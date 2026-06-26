// Vehicle-agnostic delivery-offer generator. Self-contained — depends only on
// POIs, GenerationConfig, and the deterministic RNG from profiles. Replaces the
// HGV-only freight generator: every fleet type produces "deliveries" whose
// products, equipment label, weight band, hazmat rate, and per-km rate scale to
// the selected vehicle class (an e-bike carries parcels in an insulated bag; an
// HGV hauls pallets on a tautliner). Enriched with vehicle_equipment / per-km
// rate / partner_id / status / posted_at columns to power the marketplace page
// filters and badges.

import { GenerationConfig, createRng, resolveVehicleType, VehicleType } from '../profiles';
import { POI, DeliveryOffer, Partner } from './types';

// Per-vehicle-class delivery content defaults. Config knobs
// (delivery_sources / delivery_products / delivery_equipment) override these;
// these are the built-in, vehicle-appropriate fallbacks so any preset — and any
// user-added vehicle class — produces semantically sensible deliveries with no
// code edit. weight_kg band mirrors OPENROUTESERVICE_APP.CORE.VEHICLE_CLASS_PROFILE
// (SHIPMENT_KG_MIN/MAX); the SQL VW_EXTERNAL_DELIVERIES view re-clamps to the
// authoritative DB band, so this only needs to be reasonable.
interface DeliveryClassDefaults {
  products: string[];
  equipment: string[];
  weight_kg: { min: number; max: number };
  hazmat_rate: number;     // probability a delivery is hazmat
  base_rate_per_km: number; // USD/km market mean
}

const NEUTRAL_SOURCES = ['DISPATCH', 'MARKETPLACE', 'PARTNER_APP', 'INTERNAL'];

const DELIVERY_DEFAULTS: Record<VehicleType, DeliveryClassDefaults> = {
  ebike: {
    products: ['Food order', 'Parcel', 'Documents', 'Groceries', 'Pharmacy items', 'Flowers'],
    equipment: ['INSULATED_BAG', 'TOP_BOX', 'PANNIER', 'BACKPACK'],
    weight_kg: { min: 2, max: 25 },
    hazmat_rate: 0.0,
    base_rate_per_km: 4.5,
  },
  car: {
    products: ['Parcel', 'Documents', 'Groceries', 'Retail order', 'Electronics', 'Auto parts'],
    equipment: ['CARGO_BAY', 'REAR_SEAT', 'ROOF_BOX', 'TRUNK'],
    weight_kg: { min: 5, max: 400 },
    hazmat_rate: 0.01,
    base_rate_per_km: 2.2,
  },
  hgv: {
    products: ['Pallets (general)', 'Steel coils', 'Plastic granulate', 'Beverages', 'Furniture', 'Bulk paper'],
    equipment: ['TAUTLINER', 'MEGA', 'REEFER', 'BOX', 'FLATBED'],
    weight_kg: { min: 1000, max: 24000 },
    hazmat_rate: 0.08,
    base_rate_per_km: 1.3,
  },
};

function classDefaults(vt: VehicleType): DeliveryClassDefaults {
  return DELIVERY_DEFAULTS[vt] ?? DELIVERY_DEFAULTS.car;
}

function haversineKm(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 6371;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLon = ((lon2 - lon1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) * Math.cos((lat2 * Math.PI) / 180) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

export function generateDeliveries(
  pois: POI[],
  config: GenerationConfig,
  n = 300,
  partners: Partner[] = [],
): DeliveryOffer[] {
  if (!pois || pois.length < 2) return [];
  const vt = resolveVehicleType(config);
  const cls = classDefaults(vt);
  const rng = createRng((config.region || '').length * 1009 + (config.ors_profile || '').length * 17);
  // Config overrides take precedence; the vehicle-class defaults are fallbacks.
  const sources = config.delivery_sources?.length ? config.delivery_sources : NEUTRAL_SOURCES;
  const products = config.delivery_products?.length ? config.delivery_products : cls.products;
  const equipments = config.delivery_equipment?.length ? config.delivery_equipment : cls.equipment;
  const wkMin = config.delivery_weight_kg?.min ?? cls.weight_kg.min;
  const wkMax = config.delivery_weight_kg?.max ?? cls.weight_kg.max;
  const hazmatRate = config.delivery_hazmat_rate ?? cls.hazmat_rate;
  const baseRate = config.delivery_base_rate_per_km ?? cls.base_rate_per_km;
  const offers: DeliveryOffer[] = [];
  let safety = 0;
  while (offers.length < n && safety < n * 5) {
    safety++;
    const pIdx = Math.floor(rng() * pois.length);
    const dIdx = Math.floor(rng() * pois.length);
    if (pIdx === dIdx) continue;
    const p = pois[pIdx];
    const d = pois[dIdx];
    const wt = Math.max(1, Math.round(wkMin + rng() * Math.max(0, wkMax - wkMin)));
    const distanceKm = Math.max(1, haversineKm(p.lat, p.lng, d.lat, d.lng));
    const equipment = equipments[Math.floor(rng() * equipments.length)];
    const haz = rng() < hazmatRate;
    // USD/km swings around the class market mean with a noise term so RATE_INDEX
    // has meaningful p25/p50/p75 spread.
    const ratePerKm = Math.max(0.5, baseRate + (rng() - 0.5) * baseRate * 0.45);
    const price = Math.max(8, Math.round(ratePerKm * distanceKm));
    const winStart = 30 + Math.floor(rng() * 1140);
    const winLen = 30 + Math.floor(rng() * 420);
    const src = sources[offers.length % sources.length];
    const product = products[offers.length % products.length];
    // Status: ~78% OPEN, 17% TAKEN, 5% EXPIRED — gives the page a live feel.
    const sRoll = rng();
    const status = sRoll < 0.78 ? 'OPEN' : sRoll < 0.95 ? 'TAKEN' : 'EXPIRED';
    // Posted within the last 24h, weighted toward more recent.
    const ageMin = -Math.floor(Math.pow(rng(), 1.6) * 1440);
    const partner = partners.length > 0 ? partners[Math.floor(rng() * partners.length)] : null;
    offers.push({
      offer_id: `DLV-${String(offers.length + 1).padStart(6, '0')}`,
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
      listing_text: `${src} ${p.name} -> ${d.name} ${wt} kg ${product} ${price}${haz ? ' HAZMAT' : ''} ${equipment}`,
      vehicle_equipment: equipment,
      distance_km: Math.round(distanceKm * 10) / 10,
      price_per_km_usd: Math.round(ratePerKm * 100) / 100,
      partner_id: partner ? partner.partner_id : 'P-UNKNOWN',
      status,
      posted_at_offset_min: ageMin,
    });
  }
  return offers;
}

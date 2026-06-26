// Synthetic partner / shipper directory + lane-history generator. Mirrors the
// delivery engine's deterministic-RNG style so per-preset jobs produce a
// stable Partner pool (and stable lane history) across reruns. Powers the
// deliveries marketplace page's trust badges and lane-history tooltip.

import { GenerationConfig, createRng } from '../profiles';
import { Partner, PartnerHistoryRow } from './types';

function countriesForRegion(region: string): string[] {
  const r = (region || '').toLowerCase();
  if (r.includes('germany')) return ['DE', 'NL', 'PL', 'CZ', 'AT', 'BE', 'FR'];
  if (r.includes('france')) return ['FR', 'BE', 'ES', 'IT', 'DE', 'CH'];
  if (r.includes('italy')) return ['IT', 'FR', 'CH', 'AT', 'SI'];
  if (r.includes('spain')) return ['ES', 'PT', 'FR', 'IT'];
  if (r.includes('netherlands')) return ['NL', 'BE', 'DE', 'FR', 'GB'];
  if (r.includes('europe')) return ['DE', 'NL', 'FR', 'IT', 'ES', 'PL', 'BE', 'AT'];
  if (r.includes('uk') || r.includes('britain') || r.includes('london')) return ['GB', 'IE', 'FR', 'NL'];
  // North America fallback
  return ['US', 'CA', 'MX'];
}

function nameSuffixForCountry(country: string): string[] {
  const map: Record<string, string[]> = {
    DE: ['GmbH', 'Logistik GmbH', 'Spedition KG', 'Transport AG'],
    FR: ['SARL', 'Transports SAS', 'Logistique SA'],
    IT: ['S.r.l.', 'Trasporti S.p.A.', 'Logistica S.r.l.'],
    ES: ['S.L.', 'Transportes S.A.', 'Logística SLU'],
    NL: ['B.V.', 'Transport B.V.', 'Logistiek B.V.'],
    PL: ['Sp. z o.o.', 'Transport Sp. z o.o.'],
    CZ: ['s.r.o.', 'Doprava a.s.'],
    AT: ['GmbH', 'Spedition GmbH'],
    BE: ['NV', 'BVBA Transport'],
    GB: ['Ltd', 'Logistics Ltd', 'Haulage Ltd'],
    IE: ['Ltd', 'Logistics Ltd'],
    CH: ['AG', 'Transport AG'],
    SI: ['d.o.o.', 'Logistika d.o.o.'],
    PT: ['Lda', 'Transportes Lda'],
    US: ['Inc', 'Trucking Inc', 'Logistics LLC', 'Freight Co'],
    CA: ['Inc', 'Transport Ltd'],
    MX: ['S.A. de C.V.', 'Transportes S.A.'],
  };
  return map[country] || ['Ltd'];
}

const NAME_ROOTS = [
  'Polaris', 'Atlas', 'Meridian', 'Heimdall', 'Vega', 'Orion', 'Astra',
  'Helix', 'Nimbus', 'Cascade', 'Northwind', 'Saber', 'Vector', 'Apex',
  'Pinnacle', 'Vanguard', 'Trident', 'Sentinel', 'Constellation', 'Aurora',
  'Voyager', 'Compass', 'Beacon', 'Horizon', 'Summit', 'Pioneer',
  'Express', 'Velocity', 'Cargo', 'Kinetic', 'Forward', 'Zenith',
];

export function generatePartners(config: GenerationConfig, n = 80): Partner[] {
  const rng = createRng((config.region || '').length * 2017 + (config.ors_profile || '').length * 23 + 991);
  // Config overrides take precedence; the region-derived list / NAME_ROOTS are fallbacks.
  const countries = config.partner_countries?.length ? config.partner_countries : countriesForRegion(config.region);
  const nameRoots = config.partner_name_roots?.length ? config.partner_name_roots : NAME_ROOTS;
  const partners: Partner[] = [];
  for (let i = 0; i < n; i++) {
    const country = countries[Math.floor(rng() * countries.length)];
    const root = nameRoots[Math.floor(rng() * nameRoots.length)];
    const suffixes = nameSuffixForCountry(country);
    const suffix = suffixes[Math.floor(rng() * suffixes.length)];
    // Roughly 70% strong, 22% medium, 6% weak, 2% blacklisted.
    const tier = rng();
    let creditScore: number;
    let kyc: string;
    let blacklist = false;
    if (tier < 0.70) {
      creditScore = 70 + Math.floor(rng() * 30);
      kyc = 'VERIFIED';
    } else if (tier < 0.92) {
      creditScore = 40 + Math.floor(rng() * 30);
      kyc = rng() < 0.5 ? 'VERIFIED' : 'PENDING';
    } else if (tier < 0.98) {
      creditScore = 15 + Math.floor(rng() * 25);
      kyc = 'PENDING';
    } else {
      creditScore = Math.floor(rng() * 20);
      kyc = 'REJECTED';
      blacklist = true;
    }
    const paymentDays = 14 + Math.floor(rng() * 60);
    const founded = 1980 + Math.floor(rng() * 44);
    partners.push({
      partner_id: `P-${String(i + 1).padStart(5, '0')}`,
      name: `${root} ${suffix}`,
      country,
      credit_score: creditScore,
      payment_days_avg: paymentDays,
      kyc_status: kyc,
      blacklist_flag: blacklist,
      founded_year: founded,
    });
  }
  return partners;
}

export function generatePartnerHistory(
  partners: Partner[],
  config: GenerationConfig,
  rowsPerPartner = 6,
): PartnerHistoryRow[] {
  const rng = createRng((config.region || '').length * 433 + (config.ors_profile || '').length * 53 + 17);
  // Vehicle-appropriate equipment for lane history; config override wins, else
  // the delivery-class default, else a neutral fallback.
  const equipments = config.delivery_equipment?.length
    ? config.delivery_equipment
    : ['CARGO_BAY', 'BOX', 'REEFER', 'FLATBED', 'VAN'];
  const countries = countriesForRegion(config.region);
  const rows: PartnerHistoryRow[] = [];
  for (const p of partners) {
    const k = 2 + Math.floor(rng() * (rowsPerPartner * 2 - 2));
    for (let i = 0; i < k; i++) {
      const oc = countries[Math.floor(rng() * countries.length)];
      let dc = countries[Math.floor(rng() * countries.length)];
      if (dc === oc && countries.length > 1) dc = countries[(countries.indexOf(oc) + 1) % countries.length];
      const eq = equipments[Math.floor(rng() * equipments.length)];
      const costPerKm = 0.85 + rng() * 1.05;
      // Stronger partners produce better outcomes.
      const outcomeRoll = rng() * (p.credit_score >= 70 ? 0.25 : p.credit_score >= 40 ? 0.6 : 1.0);
      const outcome = outcomeRoll < 0.05 ? 'DAMAGED' : outcomeRoll < 0.15 ? 'LATE' : 'DELIVERED';
      rows.push({
        partner_id: p.partner_id,
        origin_country: oc,
        dest_country: dc,
        vehicle_equipment: eq,
        shipped_at_offset_days: -(1 + Math.floor(rng() * 180)),
        cost_per_km: Math.round(costPerKm * 100) / 100,
        outcome,
      });
    }
  }
  return rows;
}

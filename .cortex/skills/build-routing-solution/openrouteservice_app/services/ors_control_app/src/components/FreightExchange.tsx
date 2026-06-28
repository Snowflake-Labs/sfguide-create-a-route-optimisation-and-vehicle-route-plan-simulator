// Freight Exchange page (Phase A + B). Reads only from
// FLEET_INTELLIGENCE.MARKETPLACE.VW_OFFER_ENRICHED. Mirrors what dispatchers
// do today on Timocom / WTransnet / Teleroute / B2P (or DAT / Truckstop /
// Convoy / Uber Freight in NA): a sortable grid + map of offers with vendor /
// equipment / ADR / price / age filters, plus trust + market-rate badges.
//
// This file is the orchestrator only - state, derived memos, and layout.
// All SQL, styling, badge renderers, filter controls, grid markup, map
// layers, and drawer panels live in ./freight-exchange/*.
//
// Phase C (saved searches, posting, chat, bidding, alerts) and Phase D
// (docs, cross-border, round-trip, tariff calculator) are NOT in this file -
// see references/productisation.md.

import { useEffect, useMemo, useState } from 'react';
import FilterBar from './freight-exchange/FilterBar';
import OffersGrid from './freight-exchange/OffersGrid';
import OffersMap from './freight-exchange/OffersMap';
import OfferDrawer from './freight-exchange/OfferDrawer';
import { useOffers, useLaneHistory, useSelectedOfferRoute } from './freight-exchange/sql';
import { EQUIPMENTS, TRUST_RANK, MARKET_RANK } from './freight-exchange/constants';
import type { Offer, FilterState, SortKey, SortDir } from './freight-exchange/types';

const INITIAL_FILTERS: FilterState = {
  sourcesEnabled: {},
  equipEnabled: Object.fromEntries(EQUIPMENTS.map(e => [e, true])),
  adrOnly: 'any',
  statusFilter: 'OPEN',
  usdPerKmMin: '',
  usdPerKmMax: '',
  trustFilter: 'ANY',
};

export default function FreightExchange() {
  const { rows: offers, loading } = useOffers();
  const [filters, setFilters] = useState<FilterState>(INITIAL_FILTERS);
  const [selected, setSelected] = useState<Offer | null>(null);
  const [sortKey, setSortKey] = useState<SortKey>('POSTED_AGE_MIN');
  const [sortDir, setSortDir] = useState<SortDir>('asc');
  const laneHistory = useLaneHistory(selected?.PARTNER_ID, selected?.EQUIPMENT);
  const route = useSelectedOfferRoute(selected);

  // Seed source toggles once when offers first arrive. The guard preserves
  // any subsequent user toggles - without it, a re-fetch would wipe the
  // user's selections and re-render every chip as enabled.
  useEffect(() => {
    if (!offers.length) return;
    setFilters(p => {
      if (Object.keys(p.sourcesEnabled).length > 0) return p;
      const seen: Record<string, boolean> = {};
      for (const o of offers) if (o.SOURCE) seen[o.SOURCE] = true;
      return { ...p, sourcesEnabled: seen };
    });
  }, [offers]);

  const filtered = useMemo(() => {
    const out = offers.filter(o => {
      if (filters.sourcesEnabled[o.SOURCE] === false) return false;
      if (o.EQUIPMENT && filters.equipEnabled[o.EQUIPMENT] === false) return false;
      if (filters.adrOnly === 'adr' && !o.HAZMAT) return false;
      if (filters.adrOnly === 'no_adr' && o.HAZMAT) return false;
      if (filters.statusFilter === 'OPEN' && o.STATUS !== 'OPEN') return false;
      if (typeof filters.usdPerKmMin === 'number' && o.PRICE_PER_KM_USD !== null && o.PRICE_PER_KM_USD < filters.usdPerKmMin) return false;
      if (typeof filters.usdPerKmMax === 'number' && o.PRICE_PER_KM_USD !== null && o.PRICE_PER_KM_USD > filters.usdPerKmMax) return false;
      if (filters.trustFilter === 'GREEN' && o.TRUST_BADGE !== 'GREEN') return false;
      if (filters.trustFilter === 'GREEN_OR_YELLOW' && o.TRUST_BADGE === 'RED') return false;
      return true;
    });
    out.sort((a, b) => {
      const dir = sortDir === 'asc' ? 1 : -1;
      let av: any = (a as any)[sortKey];
      let bv: any = (b as any)[sortKey];
      if (sortKey === 'TRUST_BADGE') { av = TRUST_RANK[av || 'YELLOW'] ?? 9; bv = TRUST_RANK[bv || 'YELLOW'] ?? 9; }
      if (sortKey === 'MARKET_BADGE') { av = MARKET_RANK[av || 'UNKNOWN'] ?? 9; bv = MARKET_RANK[bv || 'UNKNOWN'] ?? 9; }
      if (av === null || av === undefined) av = '';
      if (bv === null || bv === undefined) bv = '';
      if (typeof av === 'number' && typeof bv === 'number') return (av - bv) * dir;
      return String(av).localeCompare(String(bv)) * dir;
    });
    return out;
  }, [offers, filters, sortKey, sortDir]);

  const onSort = (key: SortKey) => {
    if (sortKey === key) setSortDir(d => (d === 'asc' ? 'desc' : 'asc'));
    else { setSortKey(key); setSortDir('asc'); }
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: 'calc(100vh - 80px)', gap: 8, padding: 12 }}>
      <FilterBar
        filters={filters}
        setFilters={setFilters}
        filteredCount={filtered.length}
        totalCount={offers.length}
      />
      <div style={{ display: 'grid', gridTemplateColumns: '1.2fr 1fr', gap: 8, flex: 1, minHeight: 0 }}>
        <OffersGrid
          rows={filtered}
          loading={loading}
          totalRows={offers.length}
          selected={selected}
          onSelect={setSelected}
          sortKey={sortKey}
          sortDir={sortDir}
          onSort={onSort}
        />
        <div style={{ display: 'grid', gridTemplateRows: '1fr 1fr', gap: 8, minHeight: 0 }}>
          <OffersMap rows={filtered} selected={selected} onSelect={setSelected} route={route} />
          <OfferDrawer selected={selected} laneHistory={laneHistory} route={route} />
        </div>
      </div>
    </div>
  );
}

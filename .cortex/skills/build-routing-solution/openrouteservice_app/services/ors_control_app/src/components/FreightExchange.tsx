// Freight Exchange page (Phase A + B). Reads only from
// FLEET_INTELLIGENCE.MARKETPLACE.VW_OFFER_ENRICHED. Mirrors what dispatchers
// do today on Timocom / WTransnet / Teleroute / B2P (or DAT / Truckstop /
// Convoy / Uber Freight in NA): a sortable grid + map of offers with vendor /
// equipment / ADR / price / age filters, plus trust + market-rate badges.
//
// Phase C (saved searches, posting, chat, bidding, alerts) and Phase D
// (docs, cross-border, round-trip, tariff calculator) are NOT in this file —
// see references/productisation.md.

import { useState, useEffect, useMemo } from 'react';
import DeckGL from '@deck.gl/react';
import { ScatterplotLayer } from '@deck.gl/layers';
import { TileLayer } from '@deck.gl/geo-layers';
import { BitmapLayer } from '@deck.gl/layers';
import { sfQuery } from '../lib/sfQuery';

const FX_DB = 'FLEET_INTELLIGENCE';
const FX_SCHEMA = 'MARKETPLACE';

interface Offer {
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
}

interface LaneRow {
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

const ALL_SOURCES_EU = ['TIMOCOM', 'WTRANSNET', 'TELEROUTE', 'B2P'];
const ALL_SOURCES_NA = ['DAT', 'TRUCKSTOP', 'CONVOY', 'UBER_FREIGHT'];
const EQUIPMENTS = ['TAUTLINER', 'MEGA', 'REEFER', 'BOX', 'FLATBED'];

const SOURCE_COLOR: Record<string, [number, number, number]> = {
  TIMOCOM: [255, 122, 0],
  WTRANSNET: [0, 122, 255],
  TELEROUTE: [255, 200, 0],
  B2P: [180, 0, 200],
  DAT: [255, 100, 100],
  TRUCKSTOP: [100, 200, 100],
  CONVOY: [120, 120, 220],
  UBER_FREIGHT: [40, 40, 40],
};

function cartoBasemap() {
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

type SortKey =
  | 'SOURCE' | 'PICKUP_CITY' | 'DROPOFF_CITY' | 'EQUIPMENT'
  | 'WEIGHT_KG' | 'PRICE_USD' | 'PRICE_PER_KM_USD' | 'DISTANCE_KM'
  | 'POSTED_AGE_MIN' | 'TRUST_BADGE' | 'MARKET_BADGE' | 'STATUS';

const TRUST_RANK: Record<string, number> = { GREEN: 1, YELLOW: 2, RED: 3 };
const MARKET_RANK: Record<string, number> = { BELOW_MARKET: 1, AT_MARKET: 2, ABOVE_MARKET: 3, UNKNOWN: 4 };

export default function FreightExchange() {
  const [offers, setOffers] = useState<Offer[]>([]);
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState<Offer | null>(null);
  const [laneHistory, setLaneHistory] = useState<LaneRow | null>(null);

  // Filters
  const [sourcesEnabled, setSourcesEnabled] = useState<Record<string, boolean>>({});
  const [equipEnabled, setEquipEnabled] = useState<Record<string, boolean>>(
    Object.fromEntries(EQUIPMENTS.map(e => [e, true])),
  );
  const [adrOnly, setAdrOnly] = useState<'any' | 'adr' | 'no_adr'>('any');
  const [statusFilter, setStatusFilter] = useState<'OPEN' | 'ALL'>('OPEN');
  const [usdPerKmMin, setUsdPerKmMin] = useState<number | ''>('');
  const [usdPerKmMax, setUsdPerKmMax] = useState<number | ''>('');
  const [maxAgeMin, setMaxAgeMin] = useState<number>(1440);
  const [trustFilter, setTrustFilter] = useState<'ANY' | 'GREEN' | 'GREEN_OR_YELLOW'>('ANY');

  const [sortKey, setSortKey] = useState<SortKey>('POSTED_AGE_MIN');
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('asc');

  // Initial fetch
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    sfQuery(
      `SELECT * FROM ${FX_DB}.${FX_SCHEMA}.VW_OFFER_ENRICHED ORDER BY POSTED_AT DESC LIMIT 500`,
      FX_DB, FX_SCHEMA,
    ).then(rows => {
      if (cancelled) return;
      setOffers(rows as Offer[]);
      // Initialize source toggles based on which sources show up.
      const seen = new Set<string>();
      for (const r of rows as Offer[]) if (r.SOURCE) seen.add(r.SOURCE);
      const initial: Record<string, boolean> = {};
      for (const s of seen) initial[s] = true;
      setSourcesEnabled(initial);
      setLoading(false);
    }).catch(() => {
      if (!cancelled) setLoading(false);
    });
    return () => { cancelled = true; };
  }, []);

  // Lane history fetch when a selection happens.
  useEffect(() => {
    if (!selected || !selected.PARTNER_ID || !selected.EQUIPMENT) {
      setLaneHistory(null);
      return;
    }
    let cancelled = false;
    sfQuery(
      `SELECT * FROM ${FX_DB}.${FX_SCHEMA}.VW_LANE_HISTORY
       WHERE PARTNER_ID = '${selected.PARTNER_ID.replace(/'/g, "''")}'
         AND EQUIPMENT = '${selected.EQUIPMENT.replace(/'/g, "''")}'
       LIMIT 1`,
      FX_DB, FX_SCHEMA,
    ).then(rows => {
      if (cancelled) return;
      setLaneHistory((rows as LaneRow[])[0] || null);
    });
    return () => { cancelled = true; };
  }, [selected?.PARTNER_ID, selected?.EQUIPMENT]);

  const filtered = useMemo(() => {
    const out = offers.filter(o => {
      if (sourcesEnabled[o.SOURCE] === false) return false;
      if (o.EQUIPMENT && equipEnabled[o.EQUIPMENT] === false) return false;
      if (adrOnly === 'adr' && !o.HAZMAT) return false;
      if (adrOnly === 'no_adr' && o.HAZMAT) return false;
      if (statusFilter === 'OPEN' && o.STATUS !== 'OPEN') return false;
      if (typeof usdPerKmMin === 'number' && o.PRICE_PER_KM_USD !== null && o.PRICE_PER_KM_USD < usdPerKmMin) return false;
      if (typeof usdPerKmMax === 'number' && o.PRICE_PER_KM_USD !== null && o.PRICE_PER_KM_USD > usdPerKmMax) return false;
      if (o.POSTED_AGE_MIN > maxAgeMin) return false;
      if (trustFilter === 'GREEN' && o.TRUST_BADGE !== 'GREEN') return false;
      if (trustFilter === 'GREEN_OR_YELLOW' && o.TRUST_BADGE === 'RED') return false;
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
  }, [offers, sourcesEnabled, equipEnabled, adrOnly, statusFilter, usdPerKmMin, usdPerKmMax, maxAgeMin, trustFilter, sortKey, sortDir]);

  const initialView = useMemo(() => {
    if (!offers.length) return { longitude: -122.4, latitude: 37.7, zoom: 4 };
    const lons = offers.map(o => o.PICKUP_LON).filter(n => Number.isFinite(n));
    const lats = offers.map(o => o.PICKUP_LAT).filter(n => Number.isFinite(n));
    const lon = lons.reduce((a, b) => a + b, 0) / lons.length;
    const lat = lats.reduce((a, b) => a + b, 0) / lats.length;
    return { longitude: lon, latitude: lat, zoom: 5 };
  }, [offers]);

  const layers = useMemo(() => {
    return [
      cartoBasemap(),
      new ScatterplotLayer({
        id: 'fx-offers',
        data: filtered,
        getPosition: (o: Offer) => [o.PICKUP_LON, o.PICKUP_LAT],
        getRadius: 6,
        radiusUnits: 'pixels',
        getFillColor: (o: Offer) => {
          const c = SOURCE_COLOR[o.SOURCE] || [128, 128, 128];
          const alpha = o.STATUS === 'OPEN' ? 220 : 90;
          return [c[0], c[1], c[2], alpha];
        },
        getLineColor: (o: Offer) => {
          if (o.OFFER_ID === selected?.OFFER_ID) return [0, 0, 0, 255];
          if (o.TRUST_BADGE === 'RED') return [220, 38, 38, 255];
          if (o.TRUST_BADGE === 'YELLOW') return [202, 138, 4, 255];
          return [255, 255, 255, 200];
        },
        lineWidthMinPixels: 1,
        stroked: true,
        pickable: true,
        onClick: ({ object }: any) => { if (object) setSelected(object as Offer); },
      }),
    ];
  }, [filtered, selected]);

  const sourceLabels = useMemo(() => {
    const set = new Set<string>(Object.keys(sourcesEnabled));
    if (set.size === 0) return [...ALL_SOURCES_EU, ...ALL_SOURCES_NA];
    // Show EU set if any EU source is present, otherwise NA set.
    const isEu = ALL_SOURCES_EU.some(s => set.has(s));
    return isEu ? ALL_SOURCES_EU : ALL_SOURCES_NA;
  }, [sourcesEnabled]);

  const renderTrust = (b: Offer['TRUST_BADGE']) => {
    if (b === 'GREEN') return <span style={{ color: '#16a34a', fontWeight: 600 }}>● Verified</span>;
    if (b === 'YELLOW') return <span style={{ color: '#ca8a04', fontWeight: 600 }}>● Caution</span>;
    if (b === 'RED') return <span style={{ color: '#dc2626', fontWeight: 600 }}>● Risk</span>;
    return <span style={{ color: '#6b7280' }}>—</span>;
  };

  const renderMarket = (o: Offer) => {
    if (o.MARKET_BADGE === 'UNKNOWN' || o.PRICE_DELTA_PCT === null) return <span style={{ color: '#6b7280' }}>—</span>;
    const pct = o.PRICE_DELTA_PCT;
    const style: React.CSSProperties = { fontWeight: 600 };
    if (o.MARKET_BADGE === 'BELOW_MARKET') style.color = '#16a34a';
    else if (o.MARKET_BADGE === 'ABOVE_MARKET') style.color = '#dc2626';
    else style.color = '#0369a1';
    const sign = pct > 0 ? '+' : '';
    return <span style={style}>{sign}{pct.toFixed(1)}%</span>;
  };

  const sortable = (key: SortKey, label: string) => (
    <th
      style={{ padding: '6px 8px', textAlign: 'left', cursor: 'pointer', userSelect: 'none', borderBottom: '1px solid #e5e7eb', background: '#f9fafb', fontSize: 11, color: '#374151' }}
      onClick={() => {
        if (sortKey === key) setSortDir(d => (d === 'asc' ? 'desc' : 'asc'));
        else { setSortKey(key); setSortDir('asc'); }
      }}
    >
      {label}{sortKey === key ? (sortDir === 'asc' ? ' ▲' : ' ▼') : ''}
    </th>
  );

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: 'calc(100vh - 80px)', gap: 8, padding: 12 }}>
      {/* Filter bar */}
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12, alignItems: 'center', padding: 8, background: '#fff', border: '1px solid #e5e7eb', borderRadius: 6 }}>
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
          <span style={{ fontSize: 11, color: '#6b7280' }}>Source:</span>
          {sourceLabels.map(s => (
            <button
              key={s}
              onClick={() => setSourcesEnabled(p => ({ ...p, [s]: p[s] === false }))}
              style={{
                fontSize: 11,
                padding: '3px 8px',
                borderRadius: 4,
                border: '1px solid ' + (sourcesEnabled[s] !== false ? '#0369a1' : '#d1d5db'),
                background: sourcesEnabled[s] !== false ? '#e0f2fe' : '#fff',
                color: sourcesEnabled[s] !== false ? '#0369a1' : '#6b7280',
                cursor: 'pointer',
              }}
            >{s}</button>
          ))}
        </div>
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
          <span style={{ fontSize: 11, color: '#6b7280' }}>Equipment:</span>
          {EQUIPMENTS.map(e => (
            <button
              key={e}
              onClick={() => setEquipEnabled(p => ({ ...p, [e]: !p[e] }))}
              style={{
                fontSize: 11,
                padding: '3px 8px',
                borderRadius: 4,
                border: '1px solid ' + (equipEnabled[e] ? '#16a34a' : '#d1d5db'),
                background: equipEnabled[e] ? '#dcfce7' : '#fff',
                color: equipEnabled[e] ? '#15803d' : '#6b7280',
                cursor: 'pointer',
              }}
            >{e}</button>
          ))}
        </div>
        <label style={{ fontSize: 11, display: 'flex', gap: 4, alignItems: 'center' }}>
          ADR:
          <select value={adrOnly} onChange={e => setAdrOnly(e.target.value as any)} style={{ fontSize: 11, padding: '2px 6px' }}>
            <option value="any">any</option>
            <option value="adr">ADR only</option>
            <option value="no_adr">no ADR</option>
          </select>
        </label>
        <label style={{ fontSize: 11, display: 'flex', gap: 4, alignItems: 'center' }}>
          Status:
          <select value={statusFilter} onChange={e => setStatusFilter(e.target.value as any)} style={{ fontSize: 11, padding: '2px 6px' }}>
            <option value="OPEN">OPEN only</option>
            <option value="ALL">ALL</option>
          </select>
        </label>
        <label style={{ fontSize: 11, display: 'flex', gap: 4, alignItems: 'center' }}>
          Trust:
          <select value={trustFilter} onChange={e => setTrustFilter(e.target.value as any)} style={{ fontSize: 11, padding: '2px 6px' }}>
            <option value="ANY">ANY</option>
            <option value="GREEN_OR_YELLOW">No RED</option>
            <option value="GREEN">GREEN only</option>
          </select>
        </label>
        <label style={{ fontSize: 11, display: 'flex', gap: 4, alignItems: 'center' }}>
          USD/km min:
          <input type="number" value={usdPerKmMin} onChange={e => setUsdPerKmMin(e.target.value === '' ? '' : Number(e.target.value))} style={{ width: 60, fontSize: 11, padding: '2px 4px' }} step="0.1" />
        </label>
        <label style={{ fontSize: 11, display: 'flex', gap: 4, alignItems: 'center' }}>
          max:
          <input type="number" value={usdPerKmMax} onChange={e => setUsdPerKmMax(e.target.value === '' ? '' : Number(e.target.value))} style={{ width: 60, fontSize: 11, padding: '2px 4px' }} step="0.1" />
        </label>
        <label style={{ fontSize: 11, display: 'flex', gap: 4, alignItems: 'center' }}>
          Max age (min):
          <input type="number" value={maxAgeMin} onChange={e => setMaxAgeMin(Number(e.target.value) || 1440)} style={{ width: 70, fontSize: 11, padding: '2px 4px' }} step="60" />
        </label>
        <span style={{ marginLeft: 'auto', fontSize: 11, color: '#374151', fontWeight: 600 }}>
          {filtered.length} / {offers.length} offers
        </span>
      </div>

      {/* Body: grid (left) + map (right top) + detail (right bottom) */}
      <div style={{ display: 'grid', gridTemplateColumns: '1.2fr 1fr', gap: 8, flex: 1, minHeight: 0 }}>
        {/* Grid */}
        <div style={{ overflow: 'auto', border: '1px solid #e5e7eb', borderRadius: 6, background: '#fff' }}>
          {loading ? (
            <div style={{ padding: 24, color: '#6b7280' }}>Loading offers…</div>
          ) : filtered.length === 0 ? (
            <div style={{ padding: 24, color: '#6b7280' }}>
              No offers match your filters. {offers.length === 0 && (
                <span> The current preset has no FACT_FREIGHT_OFFERS rows — run a Data Studio job for the active preset.</span>
              )}
            </div>
          ) : (
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
              <thead style={{ position: 'sticky', top: 0, zIndex: 1 }}>
                <tr>
                  {sortable('SOURCE', 'Source')}
                  {sortable('PICKUP_CITY', 'Pickup')}
                  {sortable('DROPOFF_CITY', 'Drop')}
                  {sortable('DISTANCE_KM', 'Dist km')}
                  {sortable('EQUIPMENT', 'Equip')}
                  <th style={thStyle}>ADR</th>
                  {sortable('WEIGHT_KG', 'Weight')}
                  {sortable('PRICE_USD', 'USD')}
                  {sortable('PRICE_PER_KM_USD', 'USD/km')}
                  {sortable('POSTED_AGE_MIN', 'Age')}
                  {sortable('TRUST_BADGE', 'Trust')}
                  {sortable('MARKET_BADGE', 'Mkt')}
                  {sortable('STATUS', 'Status')}
                </tr>
              </thead>
              <tbody>
                {filtered.map(o => {
                  const isSel = o.OFFER_ID === selected?.OFFER_ID;
                  const sourceColor = SOURCE_COLOR[o.SOURCE] || [128, 128, 128];
                  return (
                    <tr
                      key={o.OFFER_ID}
                      onClick={() => setSelected(o)}
                      style={{ cursor: 'pointer', background: isSel ? '#dbeafe' : undefined, borderBottom: '1px solid #f3f4f6' }}
                    >
                      <td style={tdStyle}>
                        <span style={{ display: 'inline-block', width: 8, height: 8, borderRadius: 4, background: `rgb(${sourceColor.join(',')})`, marginRight: 5 }} />
                        {o.SOURCE}
                      </td>
                      <td style={tdStyle}>{o.PICKUP_CITY}</td>
                      <td style={tdStyle}>{o.DROPOFF_CITY}</td>
                      <td style={tdNum}>{o.DISTANCE_KM != null ? o.DISTANCE_KM.toFixed(0) : '—'}</td>
                      <td style={tdStyle}>{o.EQUIPMENT || '—'}</td>
                      <td style={tdStyle}>{o.HAZMAT ? `ADR ${o.ADR_CLASS || ''}` : '—'}</td>
                      <td style={tdNum}>{o.WEIGHT_KG.toLocaleString()}</td>
                      <td style={tdNum}>{'$' + o.PRICE_USD.toLocaleString()}</td>
                      <td style={tdNum}>{o.PRICE_PER_KM_USD != null ? `$${o.PRICE_PER_KM_USD.toFixed(2)}` : '—'}</td>
                      <td style={tdNum}>{o.POSTED_AGE_MIN < 60 ? `${o.POSTED_AGE_MIN}m` : `${Math.round(o.POSTED_AGE_MIN / 60)}h`}</td>
                      <td style={tdStyle}>{renderTrust(o.TRUST_BADGE)}</td>
                      <td style={tdStyle}>{renderMarket(o)}</td>
                      <td style={tdStyle}>
                        <span style={{
                          fontSize: 10, padding: '1px 6px', borderRadius: 3, fontWeight: 600,
                          color: o.STATUS === 'OPEN' ? '#15803d' : o.STATUS === 'TAKEN' ? '#6b7280' : '#dc2626',
                          background: o.STATUS === 'OPEN' ? '#dcfce7' : o.STATUS === 'TAKEN' ? '#f3f4f6' : '#fee2e2',
                        }}>{o.STATUS}</span>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>

        {/* Right column: map + detail drawer */}
        <div style={{ display: 'grid', gridTemplateRows: '1fr 1fr', gap: 8, minHeight: 0 }}>
          <div style={{ position: 'relative', border: '1px solid #e5e7eb', borderRadius: 6, overflow: 'hidden', background: '#f3f4f6' }}>
            <DeckGL initialViewState={initialView} controller={true} layers={layers} style={{ position: 'relative' }} />
          </div>
          <div style={{ overflow: 'auto', border: '1px solid #e5e7eb', borderRadius: 6, background: '#fff', padding: 12 }}>
            {!selected ? (
              <div style={{ color: '#6b7280', fontSize: 12 }}>
                Click an offer in the grid or on the map to see details, partner trust, and lane history.
              </div>
            ) : (
              <div style={{ fontSize: 12, lineHeight: 1.5 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 8 }}>
                  <div>
                    <div style={{ fontSize: 13, fontWeight: 700 }}>{selected.OFFER_ID}</div>
                    <div style={{ color: '#6b7280', fontSize: 11 }}>{selected.SOURCE}</div>
                  </div>
                  <div style={{ textAlign: 'right' }}>
                    <div>{renderTrust(selected.TRUST_BADGE)}</div>
                    <div>{renderMarket(selected)}</div>
                  </div>
                </div>
                <hr style={{ margin: '8px 0', border: 'none', borderTop: '1px solid #e5e7eb' }} />
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 6 }}>
                  <div><b>Pickup:</b> {selected.PICKUP_CITY}</div>
                  <div><b>Drop:</b> {selected.DROPOFF_CITY}</div>
                  <div><b>Distance:</b> {selected.DISTANCE_KM != null ? `${selected.DISTANCE_KM.toFixed(0)} km` : '—'}</div>
                  <div><b>Equipment:</b> {selected.EQUIPMENT || '—'}</div>
                  <div><b>Weight:</b> {selected.WEIGHT_KG.toLocaleString()} kg</div>
                  <div><b>LDM:</b> {selected.LDM != null ? selected.LDM.toFixed(1) : '—'}</div>
                  <div><b>Price:</b> ${selected.PRICE_USD.toLocaleString()}</div>
                  <div><b>USD/km:</b> {selected.PRICE_PER_KM_USD != null ? `$${selected.PRICE_PER_KM_USD.toFixed(2)}` : '—'}</div>
                  <div><b>ADR:</b> {selected.HAZMAT ? `class ${selected.ADR_CLASS}` : 'no'}</div>
                  <div><b>Status:</b> {selected.STATUS}</div>
                </div>
                <hr style={{ margin: '8px 0', border: 'none', borderTop: '1px solid #e5e7eb' }} />
                <div style={{ fontWeight: 600, marginBottom: 4, fontSize: 12 }}>Partner</div>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 4 }}>
                  <div><b>Name:</b> {selected.PARTNER_NAME || '—'}</div>
                  <div><b>Country:</b> {selected.PARTNER_COUNTRY || '—'}</div>
                  <div><b>Credit:</b> {selected.PARTNER_CREDIT_SCORE != null ? `${selected.PARTNER_CREDIT_SCORE}/100` : '—'}</div>
                  <div><b>Payment:</b> {selected.PARTNER_PAYMENT_DAYS != null ? `${selected.PARTNER_PAYMENT_DAYS}d` : '—'}</div>
                  <div><b>KYC:</b> {selected.PARTNER_KYC || '—'}</div>
                  <div><b>Blacklist:</b> {selected.PARTNER_BLACKLIST ? 'YES' : 'no'}</div>
                </div>
                <hr style={{ margin: '8px 0', border: 'none', borderTop: '1px solid #e5e7eb' }} />
                <div style={{ fontWeight: 600, marginBottom: 4, fontSize: 12 }}>Market benchmark (this equipment, this week)</div>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 4 }}>
                  <div><b>p25:</b> {selected.MARKET_P25 != null ? `$${selected.MARKET_P25.toFixed(2)}` : '—'}</div>
                  <div><b>p50:</b> {selected.MARKET_P50 != null ? `$${selected.MARKET_P50.toFixed(2)}` : '—'}</div>
                  <div><b>p75:</b> {selected.MARKET_P75 != null ? `$${selected.MARKET_P75.toFixed(2)}` : '—'}</div>
                </div>
                <hr style={{ margin: '8px 0', border: 'none', borderTop: '1px solid #e5e7eb' }} />
                <div style={{ fontWeight: 600, marginBottom: 4, fontSize: 12 }}>Lane history with this partner</div>
                {!laneHistory ? (
                  <div style={{ color: '#6b7280' }}>No prior shipments on this lane / equipment combo.</div>
                ) : (
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 4 }}>
                    <div><b>Shipments:</b> {laneHistory.SHIPMENTS}</div>
                    <div><b>On-time:</b> {laneHistory.SHIPMENTS > 0 ? `${Math.round(100 * laneHistory.ON_TIME / laneHistory.SHIPMENTS)}%` : '—'}</div>
                    <div><b>Late:</b> {laneHistory.LATE_CNT}</div>
                    <div><b>Damaged:</b> {laneHistory.DAMAGED_CNT}</div>
                    <div><b>Avg USD/km:</b> {laneHistory.AVG_EUR_PER_KM != null ? `$${laneHistory.AVG_EUR_PER_KM.toFixed(2)}` : '—'}</div>
                    <div><b>Equipment:</b> {laneHistory.EQUIPMENT}</div>
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

const thStyle: React.CSSProperties = { padding: '6px 8px', textAlign: 'left', borderBottom: '1px solid #e5e7eb', background: '#f9fafb', fontSize: 11, color: '#374151' };
const tdStyle: React.CSSProperties = { padding: '5px 8px', whiteSpace: 'nowrap' };
const tdNum: React.CSSProperties = { ...tdStyle, textAlign: 'right', fontVariantNumeric: 'tabular-nums' };

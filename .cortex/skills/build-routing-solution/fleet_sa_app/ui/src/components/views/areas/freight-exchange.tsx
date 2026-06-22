'use client';

// Tier-3 showcase: Freight Exchange. Loads live freight offers (VW_OFFER_ENRICHED)
// via /api/query, renders them as pickup->dropoff arcs on a deck.gl map colored by
// market position, and lets the user inspect an offer, draft an AI counter-offer
// (mistral-large2 via /api/fx), and plan a round trip (optimize_routes via /api/tool).

import { useEffect, useMemo, useState } from 'react';
import { ArcLayer } from '@deck.gl/layers';
import type { Layer } from '@deck.gl/core';
import MapView from '@/components/views/areas/map-view';
import { RouteMapInline } from '@/components/inline/route-map-inline';
import type { LngLat } from '@/lib/map/map-fit';

interface Offer {
  offer_id: string;
  pickup: string;
  dropoff: string;
  equipment: string;
  price: number;
  per_km: number;
  market_badge: string;
  trust_badge: string;
  partner: string;
  market_p50: number;
  p_lon: number;
  p_lat: number;
  d_lon: number;
  d_lat: number;
}

const OFFERS_SQL =
  "SELECT OFFER_ID AS offer_id, PICKUP_CITY AS pickup, DROPOFF_CITY AS dropoff, EQUIPMENT AS equipment, " +
  "PRICE_USD AS price, ROUND(PRICE_PER_KM_USD,2) AS per_km, MARKET_BADGE AS market_badge, TRUST_BADGE AS trust_badge, " +
  "PARTNER_NAME AS partner, ROUND(MARKET_P50,2) AS market_p50, PICKUP_LON AS p_lon, PICKUP_LAT AS p_lat, " +
  "DROPOFF_LON AS d_lon, DROPOFF_LAT AS d_lat FROM FLEET_APP.MARKETPLACE.VW_OFFER_ENRICHED " +
  "WHERE STATUS='OPEN' AND PICKUP_LAT IS NOT NULL AND DROPOFF_LAT IS NOT NULL ORDER BY POSTED_AT DESC LIMIT 150";

const BADGE_COLOR: Record<string, [number, number, number]> = {
  BELOW_MARKET: [34, 197, 94],
  AT_MARKET: [41, 181, 232],
  ABOVE_MARKET: [209, 55, 78],
};

function clean(s: string): string {
  return (s || '').replace(/^"|"$/g, '');
}

export function FreightExchangeView() {
  const [offers, setOffers] = useState<Offer[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [equip, setEquip] = useState('all');
  const [badge, setBadge] = useState('all');
  const [selected, setSelected] = useState<Offer | null>(null);
  const [draft, setDraft] = useState<string | null>(null);
  const [drafting, setDrafting] = useState(false);
  const [trip, setTrip] = useState<Record<string, unknown> | null>(null);
  const [tripLoading, setTripLoading] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      try {
        const res = await fetch('/api/query', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ sql: OFFERS_SQL }),
        });
        const body = await res.json();
        if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
        setOffers((body.rows as Offer[]) ?? []);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to load offers');
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  const equipOptions = useMemo(
    () => ['all', ...Array.from(new Set(offers.map((o) => o.equipment).filter(Boolean))).sort()],
    [offers],
  );

  const filtered = useMemo(
    () =>
      offers.filter(
        (o) => (equip === 'all' || o.equipment === equip) && (badge === 'all' || o.market_badge === badge),
      ),
    [offers, equip, badge],
  );

  const layers = useMemo<Layer[]>(() => {
    if (filtered.length === 0) return [];
    return [
      new ArcLayer<Offer>({
        id: 'offer-arcs',
        data: filtered,
        getSourcePosition: (d) => [d.p_lon, d.p_lat],
        getTargetPosition: (d) => [d.d_lon, d.d_lat],
        getSourceColor: (d) => [...(BADGE_COLOR[d.market_badge] ?? [120, 120, 130]), 200] as [number, number, number, number],
        getTargetColor: (d) => [...(BADGE_COLOR[d.market_badge] ?? [120, 120, 130]), 200] as [number, number, number, number],
        getWidth: (d) => (selected && d.offer_id === selected.offer_id ? 5 : 1.5),
        pickable: true,
        updateTriggers: { getWidth: [selected?.offer_id] },
      }),
    ];
  }, [filtered, selected]);

  const fitCoords = useMemo<LngLat[]>(() => {
    const out: LngLat[] = [];
    for (const o of filtered) {
      out.push([o.p_lon, o.p_lat]);
      out.push([o.d_lon, o.d_lat]);
    }
    return out;
  }, [filtered]);

  const openOffer = (o: Offer) => {
    setSelected(o);
    setDraft(null);
    setTrip(null);
    setActionError(null);
  };

  const draftCounter = async () => {
    if (!selected) return;
    setDrafting(true);
    setActionError(null);
    setDraft(null);
    try {
      const res = await fetch('/api/fx', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'draft_counter',
          offer: {
            pickup: clean(selected.pickup),
            dropoff: clean(selected.dropoff),
            equipment: selected.equipment,
            price: selected.price,
            per_km: selected.per_km,
            market_p50: selected.market_p50,
            partner: selected.partner,
            target_pct: 8,
          },
        }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
      setDraft(body.draft as string);
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Draft failed');
    } finally {
      setDrafting(false);
    }
  };

  const planRoundTrip = async () => {
    if (!selected) return;
    setTripLoading(true);
    setActionError(null);
    setTrip(null);
    try {
      const res = await fetch('/api/tool', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          verb: 'optimize_routes',
          args: [clean(selected.dropoff), clean(selected.pickup), 1, 'driving-hgv', null],
        }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
      setTrip(body.result as Record<string, unknown>);
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Optimization failed (routing service may be offline)');
    } finally {
      setTripLoading(false);
    }
  };

  const labelStyle = { fontSize: '11px', fontWeight: 600, color: 'var(--text-secondary, #6b7280)', textTransform: 'uppercase' as const };
  const selectStyle = { padding: '6px 8px', fontSize: '13px', borderRadius: '6px', border: '1px solid var(--border-default, #e5e7eb)', backgroundColor: 'var(--surface-primary, #fff)', color: 'var(--text-primary, #111827)' };
  const badgePill = (text: string, color: [number, number, number]) => (
    <span style={{ fontSize: '11px', fontWeight: 600, padding: '2px 6px', borderRadius: '10px', color: '#fff', backgroundColor: `rgb(${color[0]},${color[1]},${color[2]})` }}>{text}</span>
  );

  return (
    <div style={{ display: 'grid', gridTemplateColumns: selected ? '1fr 1.2fr 360px' : '1fr 1.4fr', gridTemplateRows: 'auto 1fr', gap: '12px', padding: '12px', height: '100%', boxSizing: 'border-box' }}>
      <div style={{ gridColumn: '1 / -1', display: 'flex', alignItems: 'center', gap: '16px', flexWrap: 'wrap' }}>
        <h2 style={{ fontSize: '16px', fontWeight: 700, margin: 0 }}>Freight Exchange</h2>
        <div style={{ display: 'flex', gap: '6px', alignItems: 'center' }}>
          <span style={labelStyle}>Equipment</span>
          <select style={selectStyle} value={equip} onChange={(e) => setEquip(e.target.value)}>
            {equipOptions.map((o) => <option key={o} value={o}>{o}</option>)}
          </select>
        </div>
        <div style={{ display: 'flex', gap: '6px', alignItems: 'center' }}>
          <span style={labelStyle}>Market</span>
          <select style={selectStyle} value={badge} onChange={(e) => setBadge(e.target.value)}>
            {['all', 'BELOW_MARKET', 'AT_MARKET', 'ABOVE_MARKET'].map((o) => <option key={o} value={o}>{o}</option>)}
          </select>
        </div>
        <span style={{ fontSize: '12px', color: 'var(--text-secondary, #6b7280)' }}>{filtered.length} offers</span>
      </div>

      <div style={{ overflow: 'auto', border: '1px solid var(--border-default, #e5e7eb)', borderRadius: '8px' }}>
        {loading && <div style={{ padding: '12px', fontSize: '13px' }}>Loading offers…</div>}
        {error && <div style={{ padding: '12px', fontSize: '13px', color: 'var(--text-error, #dc2626)' }}>{error}</div>}
        {!loading && !error && (
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '12px' }}>
            <thead>
              <tr style={{ textAlign: 'left', position: 'sticky', top: 0, backgroundColor: 'var(--surface-secondary, #f9fafb)' }}>
                <th style={{ padding: '6px 8px' }}>Lane</th>
                <th style={{ padding: '6px 8px' }}>Equip</th>
                <th style={{ padding: '6px 8px' }}>Price</th>
                <th style={{ padding: '6px 8px' }}>Market</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((o) => (
                <tr
                  key={o.offer_id}
                  onClick={() => openOffer(o)}
                  style={{ cursor: 'pointer', borderTop: '1px solid var(--border-default, #f0f0f0)', backgroundColor: selected?.offer_id === o.offer_id ? 'var(--surface-accent-subtle, #eff6ff)' : 'transparent' }}
                >
                  <td style={{ padding: '6px 8px' }}>{clean(o.pickup)} → {clean(o.dropoff)}</td>
                  <td style={{ padding: '6px 8px' }}>{o.equipment}</td>
                  <td style={{ padding: '6px 8px' }}>${o.price}</td>
                  <td style={{ padding: '6px 8px' }}>{badgePill(o.market_badge?.replace('_MARKET', ''), BADGE_COLOR[o.market_badge] ?? [120, 120, 130])}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <div style={{ position: 'relative', borderRadius: '8px', overflow: 'hidden', border: '1px solid var(--border-default, #e5e7eb)', minHeight: 300 }}>
        <MapView layers={layers} fitTo={{ coords: fitCoords }} />
      </div>

      {selected && (
        <div style={{ overflow: 'auto', border: '1px solid var(--border-default, #e5e7eb)', borderRadius: '8px', padding: '12px', display: 'flex', flexDirection: 'column', gap: '10px' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <h3 style={{ fontSize: '14px', fontWeight: 700, margin: 0 }}>{selected.offer_id}</h3>
            <button onClick={() => setSelected(null)} style={{ border: 'none', background: 'none', cursor: 'pointer', fontSize: '16px', color: 'var(--text-secondary, #6b7280)' }}>×</button>
          </div>
          <div style={{ fontSize: '13px' }}>{clean(selected.pickup)} → {clean(selected.dropoff)}</div>
          <div style={{ fontSize: '12px', color: 'var(--text-secondary, #6b7280)' }}>Carrier: {selected.partner} · Trust {selected.trust_badge}</div>
          <div style={{ display: 'flex', gap: '12px', fontSize: '13px' }}>
            <div><strong>${selected.price}</strong><div style={labelStyle}>Asking</div></div>
            <div><strong>{selected.per_km}</strong><div style={labelStyle}>$/km</div></div>
            <div><strong>{selected.market_p50 ?? '—'}</strong><div style={labelStyle}>Mkt P50 $/km</div></div>
          </div>
          <div style={{ display: 'flex', gap: '8px' }}>
            <button onClick={draftCounter} disabled={drafting} style={{ flex: 1, padding: '8px', fontSize: '13px', fontWeight: 600, borderRadius: '6px', border: 'none', cursor: drafting ? 'not-allowed' : 'pointer', backgroundColor: 'var(--surface-accent-strong, #2563eb)', color: '#fff', opacity: drafting ? 0.6 : 1 }}>
              {drafting ? 'Drafting…' : 'Draft counter-offer'}
            </button>
            <button onClick={planRoundTrip} disabled={tripLoading} style={{ flex: 1, padding: '8px', fontSize: '13px', fontWeight: 600, borderRadius: '6px', border: '1px solid var(--border-default, #e5e7eb)', cursor: tripLoading ? 'not-allowed' : 'pointer', backgroundColor: 'var(--surface-primary, #fff)', color: 'var(--text-primary, #111827)', opacity: tripLoading ? 0.6 : 1 }}>
              {tripLoading ? 'Planning…' : 'Plan round trip'}
            </button>
          </div>
          {actionError && <div style={{ fontSize: '12px', color: 'var(--text-error, #dc2626)' }}>{actionError}</div>}
          {draft && (
            <div style={{ fontSize: '13px', lineHeight: 1.5, padding: '10px', borderRadius: '6px', backgroundColor: 'var(--surface-secondary, #f9fafb)', border: '1px solid var(--border-default, #e5e7eb)', whiteSpace: 'pre-wrap' }}>{draft}</div>
          )}
          {trip && <RouteMapInline result={trip} />}
        </div>
      )}
    </div>
  );
}

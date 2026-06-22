'use client';

// Tier-3 showcase: Backload Matching planner. Loads empty trailers (VW_TRAILERS)
// and external freight offers (VW_EXTERNAL_OFFERS), lets the user pick a trailer +
// a candidate offer and a max empty-km budget, then plans the empty repositioning
// leg (trailer drop-off -> offer pickup) via the User get_directions verb (/api/tool)
// and renders it on the map. Mirrors the original Backload Matching page.

import { useEffect, useMemo, useState } from 'react';
import { RouteMapInline } from '@/components/inline/route-map-inline';

interface Trailer {
  trailer_id: string;
  operating_country: string;
  dropoff_city: string;
  max_payload_kg: number;
  status: string;
}
interface ExtOffer {
  offer_id: string;
  pickup_city: string;
  pickup_country: string;
  dropoff_city: string;
  weight_kg: number;
  price_eur: number;
}

const TRAILERS_SQL =
  "SELECT TRAILER_ID AS trailer_id, OPERATING_COUNTRY AS operating_country, DROPOFF_CITY AS dropoff_city, " +
  "MAX_PAYLOAD_KG AS max_payload_kg, STATUS AS status FROM FLEET_APP.BACKLOAD_MATCHING.VW_TRAILERS " +
  "WHERE DROPOFF_CITY IS NOT NULL ORDER BY TRAILER_ID LIMIT 200";
const OFFERS_SQL =
  "SELECT OFFER_ID AS offer_id, PICKUP_CITY AS pickup_city, PICKUP_COUNTRY AS pickup_country, DROPOFF_CITY AS dropoff_city, " +
  "WEIGHT_KG AS weight_kg, PRICE_EUR AS price_eur FROM FLEET_APP.BACKLOAD_MATCHING.VW_EXTERNAL_OFFERS " +
  "WHERE PICKUP_CITY IS NOT NULL ORDER BY OFFER_ID LIMIT 300";

async function runQuery<T>(sql: string): Promise<T[]> {
  const res = await fetch('/api/query', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sql }),
  });
  const body = await res.json();
  if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
  return (body.rows as T[]) ?? [];
}

export function BackloadMatchingView() {
  const [trailers, setTrailers] = useState<Trailer[]>([]);
  const [offers, setOffers] = useState<ExtOffer[]>([]);
  const [trailerId, setTrailerId] = useState('');
  const [offerId, setOfferId] = useState('');
  const [budgetKm, setBudgetKm] = useState(150);
  const [loading, setLoading] = useState(true);
  const [planning, setPlanning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [route, setRoute] = useState<Record<string, unknown> | null>(null);

  useEffect(() => {
    (async () => {
      try {
        const [t, o] = await Promise.all([runQuery<Trailer>(TRAILERS_SQL), runQuery<ExtOffer>(OFFERS_SQL)]);
        setTrailers(t);
        setOffers(o);
        if (t[0]) setTrailerId(t[0].trailer_id);
        if (o[0]) setOfferId(o[0].offer_id);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to load backload data');
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  const trailer = useMemo(() => trailers.find((t) => t.trailer_id === trailerId) ?? null, [trailers, trailerId]);
  const offer = useMemo(() => offers.find((o) => o.offer_id === offerId) ?? null, [offers, offerId]);

  const plan = async () => {
    if (!trailer || !offer) return;
    setPlanning(true);
    setActionError(null);
    setRoute(null);
    const from = `${trailer.dropoff_city}, ${trailer.operating_country}`;
    const to = `${offer.pickup_city}, ${offer.pickup_country}`;
    try {
      const res = await fetch('/api/tool', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ verb: 'get_directions', args: [from, to] }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
      setRoute(body.result as Record<string, unknown>);
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Routing failed (service may be offline)');
    } finally {
      setPlanning(false);
    }
  };

  const labelStyle = { fontSize: '12px', fontWeight: 600, color: 'var(--text-secondary, #6b7280)', textTransform: 'uppercase' as const, marginBottom: '4px', display: 'block' };
  const inputStyle = { width: '100%', padding: '8px 10px', fontSize: '13px', borderRadius: '6px', border: '1px solid var(--border-default, #e5e7eb)', backgroundColor: 'var(--surface-primary, #fff)', color: 'var(--text-primary, #111827)' };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '16px', padding: '16px', height: '100%', overflow: 'auto' }}>
      <div>
        <h2 style={{ fontSize: '16px', fontWeight: 700, margin: '0 0 4px' }}>Backload Matching</h2>
        <p style={{ fontSize: '13px', color: 'var(--text-secondary, #6b7280)', margin: 0 }}>
          Match an empty trailer to an external freight offer and plan the empty repositioning leg.
        </p>
      </div>

      {loading && <div style={{ fontSize: '13px' }}>Loading trailers and offers…</div>}
      {error && <div style={{ fontSize: '13px', color: 'var(--text-error, #dc2626)' }}>{error}</div>}

      {!loading && !error && (
        <>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px' }}>
            <div>
              <label style={labelStyle}>Empty trailer (drops off at)</label>
              <select style={inputStyle} value={trailerId} onChange={(e) => setTrailerId(e.target.value)}>
                {trailers.map((t) => <option key={t.trailer_id} value={t.trailer_id}>{t.trailer_id} — {t.dropoff_city} ({t.operating_country})</option>)}
              </select>
            </div>
            <div>
              <label style={labelStyle}>Freight offer (pickup at)</label>
              <select style={inputStyle} value={offerId} onChange={(e) => setOfferId(e.target.value)}>
                {offers.map((o) => <option key={o.offer_id} value={o.offer_id}>{o.offer_id} — {o.pickup_city} ({o.pickup_country})</option>)}
              </select>
            </div>
          </div>

          <div>
            <label style={labelStyle}>Max empty-km budget: {budgetKm} km</label>
            <input type="range" min={0} max={1000} step={10} value={budgetKm} onChange={(e) => setBudgetKm(Number(e.target.value))} style={{ width: '100%' }} />
          </div>

          {trailer && offer && (
            <div style={{ fontSize: '13px', color: 'var(--text-secondary, #6b7280)' }}>
              Empty leg: <strong>{trailer.dropoff_city}</strong> → <strong>{offer.pickup_city}</strong>; then loaded: {offer.pickup_city} → {offer.dropoff_city} ({offer.weight_kg} kg, €{offer.price_eur}).
            </div>
          )}

          <div>
            <button
              onClick={plan}
              disabled={planning || !trailer || !offer}
              style={{ padding: '8px 16px', fontSize: '13px', fontWeight: 600, borderRadius: '6px', border: 'none', cursor: planning || !trailer || !offer ? 'not-allowed' : 'pointer', backgroundColor: 'var(--surface-accent-strong, #2563eb)', color: '#fff', opacity: planning || !trailer || !offer ? 0.6 : 1 }}
            >
              {planning ? 'Planning…' : 'Plan empty leg'}
            </button>
          </div>

          {actionError && <div style={{ padding: '12px', borderRadius: '8px', backgroundColor: 'var(--surface-error, #fef2f2)', border: '1px solid var(--border-error, #fecaca)', fontSize: '13px', color: 'var(--text-error, #dc2626)' }}>{actionError}</div>}
          {route && <RouteMapInline result={route} />}
        </>
      )}
    </div>
  );
}

'use client';

// Tier-3 showcase: VRP route-optimization simulator. Collects a depot, a list of
// delivery stops, and a vehicle count, calls the User `optimize_routes` verb via
// /api/tool, and renders the resulting routes on a deck.gl map (RouteMapInline).

import { useState } from 'react';
import { RouteMapInline } from '@/components/inline/route-map-inline';

const PROFILES = ['driving-car', 'driving-hgv', 'cycling-regular', 'foot-walking'];

export function VrpSimulatorView() {
  const [depot, setDepot] = useState('');
  const [stops, setStops] = useState('');
  const [vehicles, setVehicles] = useState(2);
  const [profile, setProfile] = useState('driving-car');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<Record<string, unknown> | null>(null);

  const run = async () => {
    setLoading(true);
    setError(null);
    setResult(null);
    try {
      const res = await fetch('/api/tool', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          verb: 'optimize_routes',
          args: [stops, depot, vehicles, profile, null],
        }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
      setResult(body.result as Record<string, unknown>);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Optimization failed');
    } finally {
      setLoading(false);
    }
  };

  const labelStyle = { fontSize: '12px', fontWeight: 600, color: 'var(--text-secondary, #6b7280)', textTransform: 'uppercase' as const, marginBottom: '4px', display: 'block' };
  const inputStyle = { width: '100%', padding: '8px 10px', fontSize: '13px', borderRadius: '6px', border: '1px solid var(--border-default, #e5e7eb)', backgroundColor: 'var(--surface-primary, #fff)', color: 'var(--text-primary, #111827)' };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '16px', padding: '16px', height: '100%', overflow: 'auto' }}>
      <div>
        <h2 style={{ fontSize: '16px', fontWeight: 700, margin: '0 0 4px' }}>Route Optimization Simulator</h2>
        <p style={{ fontSize: '13px', color: 'var(--text-secondary, #6b7280)', margin: 0 }}>
          Assign stops to vehicles and order them to minimize travel from a depot.
        </p>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px' }}>
        <div style={{ gridColumn: '1 / -1' }}>
          <label style={labelStyle}>Depot</label>
          <input style={inputStyle} value={depot} onChange={(e) => setDepot(e.target.value)} placeholder="e.g. Manchester depot" />
        </div>
        <div style={{ gridColumn: '1 / -1' }}>
          <label style={labelStyle}>Delivery stops (one per line or comma-separated)</label>
          <textarea style={{ ...inputStyle, minHeight: '90px', resize: 'vertical' }} value={stops} onChange={(e) => setStops(e.target.value)} placeholder="10 Downing St, London&#10;Kings Cross, London&#10;..." />
        </div>
        <div>
          <label style={labelStyle}>Vehicles</label>
          <input type="number" min={1} max={20} style={inputStyle} value={vehicles} onChange={(e) => setVehicles(Number(e.target.value))} />
        </div>
        <div>
          <label style={labelStyle}>Profile</label>
          <select style={inputStyle} value={profile} onChange={(e) => setProfile(e.target.value)}>
            {PROFILES.map((p) => <option key={p} value={p}>{p}</option>)}
          </select>
        </div>
      </div>

      <div>
        <button
          onClick={run}
          disabled={loading || !depot || !stops}
          style={{ padding: '8px 16px', fontSize: '13px', fontWeight: 600, borderRadius: '6px', border: 'none', cursor: loading || !depot || !stops ? 'not-allowed' : 'pointer', backgroundColor: 'var(--surface-accent-strong, #2563eb)', color: '#fff', opacity: loading || !depot || !stops ? 0.6 : 1 }}
        >
          {loading ? 'Optimizing…' : 'Optimize routes'}
        </button>
      </div>

      {error && <div style={{ padding: '12px', borderRadius: '8px', backgroundColor: 'var(--surface-error, #fef2f2)', border: '1px solid var(--border-error, #fecaca)', fontSize: '13px', color: 'var(--text-error, #dc2626)' }}>{error}</div>}

      {result && <RouteMapInline result={result} />}
    </div>
  );
}

'use client';

// Tier-3 showcase: Emergency-response wizard. Given an incident location and a
// response-time budget, computes the drive-time reachability (isochrone) via the
// User `compute_isochrone` verb and renders it on a deck.gl map. A simple 3-step
// flow: locate -> set response time -> view reachable area.

import { useState } from 'react';
import { RouteMapInline } from '@/components/inline/route-map-inline';

const PROFILES = ['driving-car', 'driving-hgv', 'cycling-regular', 'foot-walking'];

export function EmergencyWizardView() {
  const [location, setLocation] = useState('');
  const [minutes, setMinutes] = useState(8);
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
          verb: 'compute_isochrone',
          args: [location, minutes, profile],
        }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
      setResult(body.result as Record<string, unknown>);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Isochrone computation failed');
    } finally {
      setLoading(false);
    }
  };

  const labelStyle = { fontSize: '12px', fontWeight: 600, color: 'var(--text-secondary, #6b7280)', textTransform: 'uppercase' as const, marginBottom: '4px', display: 'block' };
  const inputStyle = { width: '100%', padding: '8px 10px', fontSize: '13px', borderRadius: '6px', border: '1px solid var(--border-default, #e5e7eb)', backgroundColor: 'var(--surface-primary, #fff)', color: 'var(--text-primary, #111827)' };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '16px', padding: '16px', height: '100%', overflow: 'auto' }}>
      <div>
        <h2 style={{ fontSize: '16px', fontWeight: 700, margin: '0 0 4px' }}>Emergency Response Coverage</h2>
        <p style={{ fontSize: '13px', color: 'var(--text-secondary, #6b7280)', margin: 0 }}>
          See the area reachable from an incident within a response-time budget.
        </p>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px' }}>
        <div style={{ gridColumn: '1 / -1' }}>
          <label style={labelStyle}>Incident location</label>
          <input style={inputStyle} value={location} onChange={(e) => setLocation(e.target.value)} placeholder="e.g. city centre fire station" />
        </div>
        <div>
          <label style={labelStyle}>Response time (minutes)</label>
          <input type="number" min={1} max={60} style={inputStyle} value={minutes} onChange={(e) => setMinutes(Number(e.target.value))} />
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
          disabled={loading || !location}
          style={{ padding: '8px 16px', fontSize: '13px', fontWeight: 600, borderRadius: '6px', border: 'none', cursor: loading || !location ? 'not-allowed' : 'pointer', backgroundColor: 'var(--surface-accent-strong, #2563eb)', color: '#fff', opacity: loading || !location ? 0.6 : 1 }}
        >
          {loading ? 'Computing…' : 'Show coverage'}
        </button>
      </div>

      {error && <div style={{ padding: '12px', borderRadius: '8px', backgroundColor: 'var(--surface-error, #fef2f2)', border: '1px solid var(--border-error, #fecaca)', fontSize: '13px', color: 'var(--text-error, #dc2626)' }}>{error}</div>}

      {result && <RouteMapInline result={result} />}
    </div>
  );
}

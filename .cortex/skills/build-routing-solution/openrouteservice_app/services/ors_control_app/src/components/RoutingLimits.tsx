import { useState, useEffect, useCallback } from 'react';
import { useRegion } from '../hooks/useRegion';

// Editable service-level routing limits. These are read by ORS at container
// start (no graph rebuild), so applying them suspend/resumes the regional ORS
// service. Field metadata mirrors the allowlist in server/routes/regions/limits.ts.

interface FieldDef {
  key: string;
  label: string;
  help: string;
  unit?: string;
}

interface Group {
  title: string;
  blurb: string;
  fields: FieldDef[];
}

const GROUPS: Group[] = [
  {
    title: 'Directions / Routing',
    blurb: 'Max total route distance and waypoints per request. Distance is the binding cap for long-haul routing (e.g. Europe-scale trucking). There is no travel-time cap on directions.',
    fields: [
      { key: 'maximum_distance', label: 'Max distance', help: 'Max total route length per request.', unit: 'm' },
      { key: 'maximum_distance_dynamic_weights', label: 'Max distance (dynamic weights)', help: 'Cap when dynamic weightings are used.', unit: 'm' },
      { key: 'maximum_distance_avoid_areas', label: 'Max distance (avoid areas)', help: 'Cap when avoid_polygons is used.', unit: 'm' },
      { key: 'maximum_distance_alternative_routes', label: 'Max distance (alternatives)', help: 'Cap for alternative-route requests.', unit: 'm' },
      { key: 'maximum_distance_round_trip_routes', label: 'Max distance (round trip)', help: 'Cap for round-trip routes.', unit: 'm' },
      { key: 'maximum_waypoints', label: 'Max waypoints', help: 'Max coordinates (stops) per directions request.' },
      { key: 'maximum_snapping_radius', label: 'Max snapping radius', help: 'How far a coordinate may sit from the road graph before it is rejected. Raise for rural/continental extracts.', unit: 'm' },
      { key: 'maximum_visited_nodes', label: 'Max visited nodes', help: 'Upper bound on the routing search space.' },
    ],
  },
  {
    title: 'Matrix',
    blurb: 'Max source x destination pairs per matrix request.',
    fields: [
      { key: 'matrix_maximum_routes', label: 'Max routes', help: 'Max O-D pairs (e.g. 500x500 = 250,000).' },
      { key: 'matrix_maximum_visited_nodes', label: 'Max visited nodes', help: 'Upper bound on the matrix search space.' },
    ],
  },
  {
    title: 'Isochrones',
    blurb: 'Reachability limits — distance and time. Time is capped here (directions are not).',
    fields: [
      { key: 'isochrones_maximum_range_distance', label: 'Max range distance', help: 'Max distance-based isochrone range.', unit: 'm' },
      { key: 'isochrones_maximum_range_time', label: 'Max range time', help: 'Max time-based isochrone range.', unit: 's' },
      { key: 'isochrones_maximum_locations', label: 'Max locations', help: 'Centers per isochrone request.' },
      { key: 'isochrones_maximum_intervals', label: 'Max intervals', help: 'Bands per isochrone.' },
    ],
  },
];

const ALL_KEYS = GROUPS.flatMap(g => g.fields.map(f => f.key));

// Distance fields shown in km as a hint; snapping radius stays in meters.
const KM_KEYS = new Set([
  'maximum_distance',
  'maximum_distance_dynamic_weights',
  'maximum_distance_avoid_areas',
  'maximum_distance_alternative_routes',
  'maximum_distance_round_trip_routes',
  'isochrones_maximum_range_distance',
]);

function fmtMeta(key: string, val: number): string | null {
  if (!Number.isFinite(val)) return null;
  if (key === 'isochrones_maximum_range_time') {
    const h = val / 3600;
    return Number.isInteger(h) ? `${h} h` : `${Math.round(val / 60)} min`;
  }
  if (KM_KEYS.has(key) && val >= 1000) return `${(val / 1000).toLocaleString()} km`;
  return null;
}

export default function RoutingLimits() {
  const { regionName, displayName } = useRegion();
  const [defaults, setDefaults] = useState<Record<string, number>>({});
  const [overrides, setOverrides] = useState<Record<string, number>>({});
  const [values, setValues] = useState<Record<string, string>>({});
  const [bounds, setBounds] = useState<Record<string, [number, number]>>({});
  const [loading, setLoading] = useState(true);
  const [applying, setApplying] = useState(false);
  const [message, setMessage] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setMessage(null);
    try {
      const r = await fetch(`/api/regions/${encodeURIComponent(regionName)}/ors-limits`);
      const data = await r.json();
      setDefaults(data.defaults || {});
      setOverrides(data.overrides || {});
      setBounds(data.bounds || {});
      const eff = data.effective || {};
      const v: Record<string, string> = {};
      for (const k of ALL_KEYS) v[k] = String(eff[k] ?? '');
      setValues(v);
    } catch (e: any) {
      setMessage({ kind: 'error', text: e?.message || 'Failed to load limits' });
    }
    setLoading(false);
  }, [regionName]);

  useEffect(() => { load(); }, [load]);

  const setField = (key: string, raw: string) => {
    setValues(prev => ({ ...prev, [key]: raw.replace(/[^0-9]/g, '') }));
  };

  const apply = async (reset: boolean) => {
    setApplying(true);
    setMessage(null);
    try {
      // On reset, send an empty object so all overrides are cleared (defaults apply).
      const limits: Record<string, number> = {};
      if (!reset) {
        for (const k of ALL_KEYS) {
          if (values[k] !== '' && values[k] != null) limits[k] = Number(values[k]);
        }
      }
      const r = await fetch(`/api/regions/${encodeURIComponent(regionName)}/ors-limits`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ limits }),
      });
      const data = await r.json();
      if (!r.ok || data.status === 'error') {
        const detail = data.errors ? data.errors.join('; ') : (data.error || 'Apply failed');
        setMessage({ kind: 'error', text: detail });
      } else {
        setMessage({
          kind: 'ok',
          text: `Applied to ${displayName}. ORS_SERVICE is restarting — the persisted graph reloads (no rebuild). Check Status & Health until graphs report Ready.`,
        });
        await load();
      }
    } catch (e: any) {
      setMessage({ kind: 'error', text: e?.message || 'Apply failed' });
    }
    setApplying(false);
  };

  const isModified = (key: string) => values[key] !== '' && Number(values[key]) !== defaults[key];
  const anyOverride = Object.keys(overrides).length > 0;

  if (loading) return <div className="panel loading">Loading routing limits...</div>;

  return (
    <div className="panel">
      <h2>Routing Limits</h2>
      <p style={{ color: 'var(--text-secondary)', fontSize: 13, marginTop: -4 }}>
        Service-level ORS limits for <strong>{displayName}</strong>. Applying re-stages the config and
        restarts the region's ORS service — the persisted graph is reloaded, never recalculated. Overrides
        persist across reprovisions.
      </p>

      <div style={{ margin: '10px 0', padding: '8px 12px', background: 'rgba(255,165,0,0.10)', border: '1px solid rgba(255,165,0,0.35)', borderRadius: 6, fontSize: 12, color: '#9a6700' }}>
        Applying briefly restarts the regional ORS service (seconds to ~1-2 min while the graph reloads).
        Requests fail until it reports Ready again. <strong>Waypoints</strong> and <strong>isochrone range time</strong>
        routed through the shared routing gateway are additionally capped by the gateway guardrail
        (defaults 1000 / 18000 s) — raising them above those here will be capped at the gateway until its
        env vars are widened.
      </div>

      {message && (
        <div style={{
          margin: '10px 0', padding: '8px 12px', borderRadius: 6, fontSize: 12,
          background: message.kind === 'ok' ? 'rgba(46,125,50,0.12)' : 'rgba(229,57,53,0.12)',
          border: `1px solid ${message.kind === 'ok' ? 'rgba(46,125,50,0.4)' : 'rgba(229,57,53,0.4)'}`,
          color: message.kind === 'ok' ? '#2e7d32' : '#e53935',
        }}>
          {message.text}
        </div>
      )}

      {GROUPS.map(group => (
        <section key={group.title} style={{ marginTop: 18 }}>
          <h3 style={{ marginBottom: 2 }}>{group.title}</h3>
          <p style={{ color: 'var(--text-secondary)', fontSize: 12, margin: '0 0 8px' }}>{group.blurb}</p>
          <table className="services-table" style={{ width: '100%' }}>
            <thead>
              <tr>
                <th>Limit</th>
                <th style={{ width: 180 }}>Value</th>
                <th style={{ width: 120 }}>Default</th>
              </tr>
            </thead>
            <tbody>
              {group.fields.map(f => {
                const b = bounds[f.key];
                const meta = fmtMeta(f.key, Number(values[f.key]));
                return (
                  <tr key={f.key}>
                    <td>
                      <div style={{ fontWeight: 500 }}>
                        {f.label}
                        {isModified(f.key) && <span className="badge warn" style={{ marginLeft: 6, fontSize: 10 }}>modified</span>}
                      </div>
                      <div style={{ fontSize: 11, color: 'var(--text-secondary)' }}>{f.help}</div>
                    </td>
                    <td>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                        <input
                          type="text"
                          inputMode="numeric"
                          value={values[f.key] ?? ''}
                          onChange={e => setField(f.key, e.target.value)}
                          disabled={applying}
                          style={{ width: 110, padding: '4px 8px', fontSize: 13, fontFamily: 'monospace' }}
                          title={b ? `Allowed range: ${b[0].toLocaleString()} - ${b[1].toLocaleString()}` : undefined}
                        />
                        {f.unit && <span style={{ fontSize: 11, color: 'var(--text-secondary)' }}>{f.unit}</span>}
                        {meta && <span style={{ fontSize: 11, color: 'var(--text-secondary)' }}>({meta})</span>}
                      </div>
                    </td>
                    <td style={{ fontSize: 12, fontFamily: 'monospace', color: 'var(--text-secondary)' }}>
                      {defaults[f.key]?.toLocaleString() ?? '—'}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </section>
      ))}

      <div style={{ display: 'flex', gap: 8, marginTop: 18, alignItems: 'center' }}>
        <button className="btn primary" disabled={applying} onClick={() => apply(false)}>
          {applying ? 'Applying…' : 'Apply & Restart ORS'}
        </button>
        <button className="btn" disabled={applying || !anyOverride} onClick={() => apply(true)} title={anyOverride ? 'Clear overrides and restore defaults' : 'No overrides to reset'}>
          Reset to defaults
        </button>
        <button className="btn" disabled={applying} onClick={load}>Reload</button>
      </div>
    </div>
  );
}

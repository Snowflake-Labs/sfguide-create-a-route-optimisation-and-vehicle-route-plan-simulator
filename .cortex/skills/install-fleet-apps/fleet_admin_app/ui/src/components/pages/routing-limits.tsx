'use client';
import { useState, useEffect, useCallback } from 'react';
import { useRegion } from '@/hooks/useRegion';

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
    blurb: 'Reachability limits - distance and time. Time is capped here (directions are not).',
    fields: [
      { key: 'isochrones_maximum_range_distance', label: 'Max range distance', help: 'Max distance-based isochrone range.', unit: 'm' },
      { key: 'isochrones_maximum_range_time', label: 'Max range time', help: 'Max time-based isochrone range.', unit: 's' },
      { key: 'isochrones_maximum_locations', label: 'Max locations', help: 'Centers per isochrone request.' },
      { key: 'isochrones_maximum_intervals', label: 'Max intervals', help: 'Bands per isochrone.' },
    ],
  },
];

const ALL_KEYS = GROUPS.flatMap(g => g.fields.map(f => f.key));

// Human-readable labels for the phases returned by /build-progress while the
// regional ORS service cycles (suspend -> reload persisted graph -> Ready).
const RESTART_LABELS: Record<string, string> = {
  waiting: 'Waiting for the service to suspend…',
  initializing: 'Service starting up…',
  importing: 'Loading the persisted graph…',
  building: 'Reloading the graph…',
  finalizing: 'Finalizing…',
  ready: 'Ready',
};

type ScalePresetId = 'city' | 'country' | 'continent';

interface ScalePreset {
  id: ScalePresetId;
  label: string;
  description: string;
  limits: Record<string, number>;
}

// Scale presets pre-fill all fields; Apply still uses PUT /api/regions/:region/ors-limits.
// Values align with routing-customization ors-config-presets (standard / hgv / continental).
const SCALE_PRESETS: ScalePreset[] = [
  {
    id: 'city',
    label: 'City',
    description: 'Metro / urban extract - routes up to ~300 km, standard snapping and VRP size.',
    limits: {
      maximum_distance: 300000,
      maximum_distance_dynamic_weights: 300000,
      maximum_distance_avoid_areas: 300000,
      maximum_distance_alternative_routes: 300000,
      maximum_distance_round_trip_routes: 300000,
      maximum_visited_nodes: 100000000,
      maximum_waypoints: 1000,
      maximum_snapping_radius: 1000,
      matrix_maximum_routes: 250000,
      matrix_maximum_visited_nodes: 100000000,
      isochrones_maximum_locations: 50,
      isochrones_maximum_intervals: 10,
      isochrones_maximum_range_distance: 150000,
      isochrones_maximum_range_time: 5400,
    },
  },
  {
    id: 'country',
    label: 'Country',
    description: 'Single large country - routes up to ~2,000 km, wider snapping for rural roads.',
    limits: {
      maximum_distance: 2000000,
      maximum_distance_dynamic_weights: 2000000,
      maximum_distance_avoid_areas: 2000000,
      maximum_distance_alternative_routes: 2000000,
      maximum_distance_round_trip_routes: 2000000,
      maximum_visited_nodes: 100000000,
      maximum_waypoints: 2000,
      maximum_snapping_radius: 2000,
      matrix_maximum_routes: 1000000,
      matrix_maximum_visited_nodes: 100000000,
      isochrones_maximum_locations: 50,
      isochrones_maximum_intervals: 10,
      isochrones_maximum_range_distance: 1500000,
      isochrones_maximum_range_time: 18000,
    },
  },
  {
    id: 'continent',
    label: 'Continent',
    description: 'Multi-country / continental extract - uncapped route distance, 5 km snapping, large VRP/matrix. Isochrone time capped at 2 h (gateway timeout safety, not geographic scale).',
    limits: {
      maximum_distance: 100000000,
      maximum_distance_dynamic_weights: 100000000,
      maximum_distance_avoid_areas: 100000000,
      maximum_distance_alternative_routes: 100000000,
      maximum_distance_round_trip_routes: 100000000,
      maximum_visited_nodes: 100000000,
      maximum_waypoints: 5000,
      maximum_snapping_radius: 5000,
      matrix_maximum_routes: 2000000,
      matrix_maximum_visited_nodes: 100000000,
      isochrones_maximum_locations: 50,
      isochrones_maximum_intervals: 10,
      isochrones_maximum_range_distance: 3000000,
      isochrones_maximum_range_time: 7200,
    },
  },
];

function limitsToFormValues(limits: Record<string, number>): Record<string, string> {
  const v: Record<string, string> = {};
  for (const k of ALL_KEYS) v[k] = String(limits[k] ?? '');
  return v;
}

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

export function RoutingLimitsPage() {
  const { regionName, displayName } = useRegion();
  const [defaults, setDefaults] = useState<Record<string, number>>({});
  const [overrides, setOverrides] = useState<Record<string, number>>({});
  const [values, setValues] = useState<Record<string, string>>({});
  const [bounds, setBounds] = useState<Record<string, [number, number]>>({});
  const [loading, setLoading] = useState(true);
  const [applying, setApplying] = useState(false);
  const [activePreset, setActivePreset] = useState<ScalePresetId | 'custom' | null>(null);
  const [message, setMessage] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);
  const [restart, setRestart] = useState<{ phase: string; progress: number } | null>(null);

  // silent=true refreshes state in place without flipping the panel to its
  // loading skeleton or clearing the current status banner (used after Apply so
  // the restart-progress / "limits live" message survives the state refresh).
  const load = useCallback(async (silent = false) => {
    if (!silent) { setLoading(true); setMessage(null); }
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
      setActivePreset(null);
    } catch (e: any) {
      if (!silent) setMessage({ kind: 'error', text: e?.message || 'Failed to load limits' });
    }
    if (!silent) setLoading(false);
  }, [regionName]);

  useEffect(() => { load(); }, [load]);

  // Poll ORS readiness after a restart so the user can see the service cycle
  // (suspend -> graph reload -> Ready) instead of staring at a static banner.
  // Resolves true once the engine reports ready, false on timeout.
  const pollRestart = useCallback(async (): Promise<boolean> => {
    const deadline = Date.now() + 4 * 60 * 1000;
    setRestart({ phase: 'waiting', progress: 0 });
    while (Date.now() < deadline) {
      await new Promise(res => setTimeout(res, 3000));
      try {
        const r = await fetch(`/api/regions/${encodeURIComponent(regionName)}/build-progress`);
        if (r.ok) {
          const d = await r.json();
          const phase = d.phase || 'waiting';
          setRestart({ phase, progress: Number(d.progress) || 0 });
          if (phase === 'ready') { setRestart(null); return true; }
        }
      } catch { /* service briefly unreachable mid-restart - keep polling */ }
    }
    setRestart(null);
    return false;
  }, [regionName]);

  const selectPreset = (id: ScalePresetId) => {
    const preset = SCALE_PRESETS.find(p => p.id === id);
    if (!preset) return;
    setValues(limitsToFormValues(preset.limits));
    setActivePreset(id);
    setMessage(null);
  };

  const setField = (key: string, raw: string) => {
    setValues(prev => ({ ...prev, [key]: raw.replace(/[^0-9]/g, '') }));
    setActivePreset('custom');
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
        setApplying(false);
        return;
      }
      setMessage({
        kind: 'ok',
        text: `Applied to ${displayName}. ORS is restarting - the persisted graph reloads (no rebuild).`,
      });
      const ready = await pollRestart();
      await load(true);
      setMessage({
        kind: 'ok',
        text: ready
          ? `Applied to ${displayName}. ORS restarted and graphs report Ready - the new limits are live.`
          : `Applied to ${displayName}. ORS is still reloading the graph. Check Status & Health until it reports Ready.`,
      });
    } catch (e: any) {
      setMessage({ kind: 'error', text: e?.message || 'Apply failed' });
    }
    setApplying(false);
  };

  const isModified = (key: string) => values[key] !== '' && Number(values[key]) !== defaults[key];
  const anyOverride = Object.keys(overrides).length > 0;
  const selectedPresetMeta = activePreset && activePreset !== 'custom'
    ? SCALE_PRESETS.find(p => p.id === activePreset)
    : null;

  if (loading) return <div className="panel loading">Loading routing limits...</div>;

  return (
    <div className="panel">
      <h2>Routing Limits</h2>
      <p style={{ color: 'var(--text-secondary)', fontSize: 13, marginTop: -4 }}>
        Service-level ORS limits for <strong>{displayName}</strong>. Applying re-stages the config and
        restarts the region's ORS service - the persisted graph is reloaded, never recalculated. Overrides
        persist across reprovisions.
      </p>

      <div style={{ margin: '10px 0', padding: '8px 12px', background: 'rgba(255,165,0,0.10)', border: '1px solid rgba(255,165,0,0.35)', borderRadius: 6, fontSize: 12, color: '#9a6700' }}>
        Applying briefly restarts the regional ORS service (seconds to ~1-2 min while the graph reloads).
        Requests fail until it reports Ready again. <strong>Waypoints</strong> and <strong>isochrone range time</strong>
        routed through the shared routing gateway are additionally capped by the gateway guardrail
        (defaults 1000 / 18000 s) - raising them above those here will be capped at the gateway until its
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

      {restart && (
        <div style={{
          margin: '10px 0', padding: '8px 12px', borderRadius: 6, fontSize: 12,
          background: 'rgba(33,150,243,0.10)', border: '1px solid rgba(33,150,243,0.4)', color: '#1565c0',
        }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 6 }}>
            <span><strong>Restarting ORS</strong> - {RESTART_LABELS[restart.phase] || restart.phase}</span>
            <span style={{ fontFamily: 'monospace' }}>{restart.progress}%</span>
          </div>
          <div style={{ height: 6, borderRadius: 3, background: 'rgba(33,150,243,0.2)', overflow: 'hidden' }}>
            <div style={{ height: '100%', width: `${Math.max(4, restart.progress)}%`, background: '#2196f3', transition: 'width 0.4s ease' }} />
          </div>
        </div>
      )}

      <section style={{ marginTop: 14 }}>
        <h3 style={{ marginBottom: 6 }}>Scale preset</h3>
        <p style={{ color: 'var(--text-secondary)', fontSize: 12, margin: '0 0 10px' }}>
          Pre-fill all limits for a typical extract size. Adjust any field afterward (switches to Custom), then Apply.
        </p>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center' }}>
          {SCALE_PRESETS.map(p => (
            <button
              key={p.id}
              type="button"
              className={`btn${activePreset === p.id ? ' primary' : ''}`}
              disabled={applying}
              onClick={() => selectPreset(p.id)}
            >
              {p.label}
            </button>
          ))}
          {activePreset === 'custom' && (
            <span className="badge warn" style={{ fontSize: 11 }}>Custom</span>
          )}
        </div>
        {selectedPresetMeta && (
          <p style={{ color: 'var(--text-secondary)', fontSize: 12, margin: '8px 0 0' }}>
            {selectedPresetMeta.description}
          </p>
        )}
        {activePreset === 'custom' && (
          <p style={{ color: 'var(--text-secondary)', fontSize: 12, margin: '8px 0 0' }}>
            Values differ from the last selected preset - edit fields freely, then Apply.
          </p>
        )}
      </section>

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
                      {defaults[f.key]?.toLocaleString() ?? '-'}
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
          {restart ? 'Restarting ORS…' : applying ? 'Applying…' : 'Apply & Restart ORS'}
        </button>
        <button className="btn" disabled={applying || !anyOverride} onClick={() => apply(true)} title={anyOverride ? 'Clear overrides and restore defaults' : 'No overrides to reset'}>
          Reset to defaults
        </button>
        <button className="btn" disabled={applying} onClick={() => load()}>Reload</button>
      </div>
    </div>
  );
}

// Page 4 -- Driver Dispatch
// Calls ORS_OPTIMIZATION_AVOIDING (VROOM with avoid_polygons) on the impacted
// participants and ON_SHIFT drivers. Renders each assigned route as a colored
// PathLayer that detours around the hazard polygon.

import { useEffect, useMemo, useState } from 'react';
import { GeoJsonLayer, PathLayer, ScatterplotLayer } from '@deck.gl/layers';
import EmergencyMap from './EmergencyMap';
import { postDispatch, fetchAlerts, EmergencyAlert } from './helpers';

type Props = { selectedAlertId?: string };

const PALETTE: [number, number, number][] = [
  [29, 161, 242],   // sky
  [233, 30, 99],    // pink
  [76, 175, 80],    // green
  [255, 152, 0],    // orange
  [156, 39, 176],   // purple
  [121, 85, 72],    // brown
  [0, 188, 212],    // cyan
  [255, 87, 34],    // deep orange
  [63, 81, 181],    // indigo
  [205, 220, 57],   // lime
];

function decodePolyline(encoded: string): [number, number][] {
  // Google polyline 5-decimal places. ORS / VROOM returns standard polyline.
  const pts: [number, number][] = [];
  let i = 0, lat = 0, lon = 0;
  while (i < encoded.length) {
    let b: number, shift = 0, result = 0;
    do { b = encoded.charCodeAt(i++) - 63; result |= (b & 0x1f) << shift; shift += 5; } while (b >= 0x20);
    const dlat = ((result & 1) ? ~(result >> 1) : (result >> 1));
    lat += dlat;
    shift = 0; result = 0;
    do { b = encoded.charCodeAt(i++) - 63; result |= (b & 0x1f) << shift; shift += 5; } while (b >= 0x20);
    const dlon = ((result & 1) ? ~(result >> 1) : (result >> 1));
    lon += dlon;
    pts.push([lon * 1e-5, lat * 1e-5]);
  }
  return pts;
}

export default function DispatchPage({ selectedAlertId }: Props) {
  const [plan, setPlan] = useState<any>(null);
  const [alert, setAlert] = useState<EmergencyAlert | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [topN, setTopN] = useState(30);

  useEffect(() => {
    if (selectedAlertId) {
      fetchAlerts().then(as => setAlert(as.find(a => a.alertId === selectedAlertId) || null)).catch(() => {});
    }
  }, [selectedAlertId]);

  async function runDispatch() {
    if (!selectedAlertId) return;
    setLoading(true);
    setError(null);
    try {
      const r = await postDispatch(selectedAlertId, topN);
      setPlan(r);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }

  const layers = useMemo(() => {
    const ll: any[] = [];
    if (alert?.boundaryGeoJson) {
      ll.push(new GeoJsonLayer({
        id: 'hazard',
        data: { type: 'Feature', properties: {}, geometry: alert.boundaryGeoJson } as any,
        getFillColor: [200, 60, 50, 60],
        getLineColor: [200, 60, 50, 230],
        lineWidthMinPixels: 2,
        stroked: true, filled: true,
      }));
    }
    if (plan?.plan?.routes) {
      const routes = plan.plan.routes;
      // Per-route path
      const pathsData = routes.map((r: any, idx: number) => {
        let path: [number, number][] = [];
        if (r.geometry && typeof r.geometry === 'string') {
          try { path = decodePolyline(r.geometry); } catch { /* */ }
        }
        if (!path.length && Array.isArray(r.steps)) {
          path = r.steps.filter((s: any) => Array.isArray(s.location)).map((s: any) => [s.location[0], s.location[1]] as [number, number]);
        }
        return { idx, path, color: PALETTE[idx % PALETTE.length] };
      }).filter((d: any) => d.path.length > 1);

      ll.push(new PathLayer({
        id: 'dispatch-routes',
        data: pathsData,
        getPath: (d: any) => d.path,
        getColor: (d: any) => d.color,
        getWidth: 5,
        widthUnits: 'pixels',
        capRounded: true,
        jointRounded: true,
      }));

      // Pickup points (job locations)
      const pickups = routes.flatMap((r: any) =>
        (r.steps || []).filter((s: any) => s.type === 'job').map((s: any) => ({
          id: s.description || s.id,
          loc: s.location as [number, number],
        }))
      );
      if (pickups.length) {
        ll.push(new ScatterplotLayer({
          id: 'pickups',
          data: pickups,
          getPosition: (d: any) => d.loc,
          getRadius: 60,
          radiusMinPixels: 4,
          radiusMaxPixels: 8,
          getFillColor: [255, 193, 7, 230],
          stroked: true, getLineColor: [60, 60, 60, 230], lineWidthMinPixels: 1,
        }));
      }

      // Driver start markers
      const starts = routes.map((r: any) => {
        const start = (r.steps || []).find((s: any) => s.type === 'start');
        if (!start) return null;
        return { idx: r.vehicle, loc: start.location as [number, number] };
      }).filter(Boolean);
      if (starts.length) {
        ll.push(new ScatterplotLayer({
          id: 'driver-starts',
          data: starts,
          getPosition: (d: any) => d.loc,
          getRadius: 80,
          radiusMinPixels: 6,
          radiusMaxPixels: 12,
          getFillColor: (d: any) => [...(PALETTE[d.idx % PALETTE.length]), 255] as any,
          stroked: true, getLineColor: [255, 255, 255, 255], lineWidthMinPixels: 2,
        }));
      }
    }
    return ll;
  }, [plan, alert]);

  const fitCoords = useMemo<[number,number][] | undefined>(() => {
    if (!plan?.plan?.routes) return undefined;
    const pts: [number, number][] = [];
    plan.plan.routes.forEach((r: any) => {
      (r.steps || []).forEach((s: any) => {
        if (Array.isArray(s.location)) pts.push(s.location as [number, number]);
      });
    });
    return pts.length ? pts : undefined;
  }, [plan]);

  if (!selectedAlertId) {
    return <p style={{ padding: 16 }}>Select an alert from the Hazard Operations Center first.</p>;
  }

  const summary = plan?.plan?.summary || {};
  const routes  = plan?.plan?.routes  || [];
  const unassigned = plan?.plan?.unassigned || [];

  return (
    <div style={{ padding: 12, height: '100%', display: 'flex', flexDirection: 'column', gap: 12 }}>
      <header style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <div>
          <h3 style={{ margin: 0 }}>Driver Dispatch -- {selectedAlertId}</h3>
          <span style={{ fontSize: 12, color: 'var(--text-secondary, #666)' }}>
            VRP solve via ORS OPTIMIZATION with <code>avoid_polygons</code> = hazard geometry
          </span>
        </div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <label style={{ fontSize: 12 }}>
            Top participants:&nbsp;
            <input type="number" value={topN} min={1} max={100} onChange={e => setTopN(Math.max(1, Math.min(100, +e.target.value)))} style={{ width: 60 }} />
          </label>
          <button
            onClick={runDispatch}
            disabled={loading}
            style={{
              padding: '6px 14px', background: '#29B5E8', color: '#fff',
              border: 'none', borderRadius: 4, cursor: loading ? 'wait' : 'pointer',
              fontSize: 13, fontWeight: 500,
            }}
          >
            {loading ? 'Solving VRP...' : 'Run Dispatch'}
          </button>
        </div>
      </header>

      {error && <p style={{ color: 'crimson' }}>Error: {error}</p>}

      {plan && (
        <div style={{ display: 'flex', gap: 12 }}>
          <Kpi label="Drivers used"           value={routes.length} />
          <Kpi label="Total cost"             value={summary.cost ?? '-'} />
          <Kpi label="Total duration (min)"   value={summary.duration ? Math.round(summary.duration / 60) : '-'} />
          <Kpi label="Unassigned"             value={unassigned.length} />
          <Kpi label="Jobs available"         value={plan.jobsCount ?? '-'} />
          <Kpi label="Drivers ON_SHIFT"       value={plan.driversCount ?? '-'} />
        </div>
      )}

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 280px', gap: 12, flex: 1, minHeight: 0 }}>
        <div style={{ minHeight: 400 }}>
          <EmergencyMap layers={layers} fitCoords={fitCoords} />
        </div>
        <aside style={{ overflowY: 'auto', border: '1px solid var(--border, #ddd)', borderRadius: 8, padding: 8 }}>
          <h4 style={{ margin: '4px 0 8px 0' }}>Routes</h4>
          {!plan && <p style={{ fontSize: 12, color: 'var(--text-secondary, #666)' }}>Click Run Dispatch to compute.</p>}
          {plan && routes.map((r: any, i: number) => {
            const c = PALETTE[i % PALETTE.length];
            const jobsCount = (r.steps || []).filter((s: any) => s.type === 'job').length;
            return (
              <div key={i} style={{ borderLeft: `4px solid rgb(${c[0]},${c[1]},${c[2]})`, padding: '4px 8px', marginBottom: 6 }}>
                <strong>Driver #{r.vehicle}</strong>
                <div style={{ fontSize: 11, color: 'var(--text-secondary, #666)' }}>
                  {jobsCount} pickups, {r.duration ? (r.duration / 60).toFixed(1) : '?'} min, {r.distance ? (r.distance / 1609.34).toFixed(1) : '?'} mi
                </div>
              </div>
            );
          })}
          {plan && unassigned.length > 0 && (
            <p style={{ fontSize: 11, color: '#b71c1c', marginTop: 8 }}>
              <strong>{unassigned.length} unassigned</strong> -- driver capacity reached or unreachable due to hazard.
            </p>
          )}
        </aside>
      </div>
    </div>
  );
}

function Kpi({ label, value }: { label: string; value: any }) {
  return (
    <div style={{ flex: 1, padding: '8px 12px', border: '1px solid var(--border, #ddd)', borderRadius: 6 }}>
      <div style={{ fontSize: 11, color: 'var(--text-secondary, #666)' }}>{label}</div>
      <div style={{ fontSize: 18, fontWeight: 600 }}>{value ?? '-'}</div>
    </div>
  );
}

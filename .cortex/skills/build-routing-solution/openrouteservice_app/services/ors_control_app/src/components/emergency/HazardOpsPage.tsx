// Page 1 -- Hazard Operations Center
// Live map with NWS alert polygons + participant scatter + center icons + KPIs.

import { useEffect, useMemo, useState } from 'react';
import { GeoJsonLayer, ScatterplotLayer } from '@deck.gl/layers';
import EmergencyMap from './EmergencyMap';
import {
  fetchAlerts, fetchKpis, fetchParticipantsSample, fetchCenters,
  EmergencyAlert, SEVERITY_COLOR, SEVERITY_HEX, fmtTime,
} from './helpers';

type Props = {
  selectedAlertId?: string;
  onSelectAlert?: (alertId: string) => void;
};

// CSP on Snowflake SPCS ingress blocks fetch() of data: URIs, so deck.gl
// IconLayer with a data:image/svg+xml atlas fails. We render centers as
// ScatterplotLayer dots styled to look like markers.

export default function HazardOpsPage({ selectedAlertId, onSelectAlert }: Props) {
  const [alerts, setAlerts] = useState<EmergencyAlert[]>([]);
  const [kpis, setKpis] = useState<any>(null);
  const [parts, setParts] = useState<{id:string;loc:[number,number];frailty:number}[]>([]);
  const [centers, setCenters] = useState<{id:string;name:string;loc:[number,number]}[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setLoading(true);
    Promise.all([
      fetchAlerts().catch(e => { setError(e.message); return []; }),
      fetchKpis().catch(() => null),
      fetchParticipantsSample(2000).catch(() => []),
      fetchCenters().catch(() => []),
    ]).then(([a, k, p, c]) => {
      setAlerts(a); setKpis(k); setParts(p); setCenters(c);
      setLoading(false);
    });
    const t = setInterval(() => fetchAlerts().then(setAlerts).catch(() => {}), 60_000);
    return () => clearInterval(t);
  }, []);

  // Auto-select first alert if none chosen and alerts exist
  useEffect(() => {
    if (!selectedAlertId && alerts.length > 0 && onSelectAlert) {
      onSelectAlert(alerts[0].alertId);
    }
  }, [alerts, selectedAlertId, onSelectAlert]);

  const layers = useMemo(() => {
    const ll: any[] = [];

    if (alerts.length) {
      const fc = {
        type: 'FeatureCollection',
        features: alerts.map(a => ({
          type: 'Feature',
          properties: { alertId: a.alertId, severity: a.severity },
          geometry: a.boundaryGeoJson,
        })).filter(f => f.geometry),
      };
      ll.push(new GeoJsonLayer({
        id: 'alerts',
        data: fc as any,
        pickable: true,
        stroked: true,
        filled: true,
        getFillColor: (f: any) => {
          const sev = f.properties.severity || 'Moderate';
          const c = SEVERITY_COLOR[sev as keyof typeof SEVERITY_COLOR] || [120,120,120,80];
          const isSel = f.properties.alertId === selectedAlertId;
          return [c[0], c[1], c[2], isSel ? 110 : 60] as [number,number,number,number];
        },
        getLineColor: (f: any) => {
          const sev = f.properties.severity || 'Moderate';
          const c = SEVERITY_COLOR[sev as keyof typeof SEVERITY_COLOR] || [120,120,120,255];
          return [c[0], c[1], c[2], 255];
        },
        lineWidthMinPixels: 2,
        onClick: (info: any) => { if (info.object?.properties?.alertId) onSelectAlert?.(info.object.properties.alertId); },
        updateTriggers: { getFillColor: [selectedAlertId] },
      }));
    }

    if (parts.length) {
      ll.push(new ScatterplotLayer({
        id: 'participants',
        data: parts,
        getPosition: (d: any) => d.loc,
        getRadius: 30,
        getFillColor: [41, 181, 232, 160],
        radiusMinPixels: 1.5,
        radiusMaxPixels: 4,
        pickable: false,
      }));
    }

    if (centers.length) {
      ll.push(new ScatterplotLayer({
        id: 'centers',
        data: centers,
        getPosition: (d: any) => d.loc,
        getRadius: 220,
        radiusMinPixels: 8,
        radiusMaxPixels: 14,
        getFillColor: [41, 181, 232, 230],
        getLineColor: [255, 255, 255, 255],
        lineWidthMinPixels: 2,
        stroked: true,
        pickable: true,
      }));
    }

    return ll;
  }, [alerts, parts, centers, selectedAlertId, onSelectAlert]);

  const fitCoords = useMemo<[number,number][] | undefined>(() => {
    const all: [number, number][] = [];
    parts.forEach(p => all.push(p.loc));
    centers.forEach(c => all.push(c.loc));
    return all.length ? all : undefined;
  }, [parts, centers]);

  const getTooltip = (info: any) => {
    if (info?.object?.properties?.alertId) {
      const a = alerts.find(x => x.alertId === info.object.properties.alertId);
      if (!a) return null;
      return {
        html: `<b>${a.eventType}</b> -- ${a.severity}<br/><i>${a.headline}</i><br/>Click to select`,
        style: { backgroundColor: '#14141f', color: '#fff', padding: '8px', borderRadius: '4px', fontSize: 12 },
      };
    }
    if (info?.object?.name) {
      return {
        html: `<b>${info.object.name}</b>`,
        style: { backgroundColor: '#14141f', color: '#fff', padding: '6px 8px', borderRadius: '4px', fontSize: 12 },
      };
    }
    return null;
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', padding: 12, gap: 12 }}>
      {/* KPI cards */}
      <div style={{ display: 'flex', gap: 12 }}>
        <Kpi label="Active Alerts"          value={kpis?.activeAlerts ?? '-'} accent="#e65100" />
        <Kpi label="Impacted Participants"  value={kpis?.impactedParticipants ?? '-'} accent="#b71c1c" />
        <Kpi label="Drivers ON_SHIFT"       value={kpis?.driversOnShift ?? '-'} accent="#2e7d32" />
        <Kpi label="Centers"                value={kpis?.totalCenters ?? '-'} accent="#29B5E8" />
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '320px 1fr', gap: 12, flex: 1, minHeight: 0 }}>
        {/* Sidebar list */}
        <aside style={{ overflowY: 'auto', borderRight: '1px solid var(--border, #ddd)', paddingRight: 8 }}>
          <h4 style={{ margin: '4px 0 8px 0' }}>Active Hazards</h4>
          {loading && <p>Loading NWS alerts...</p>}
          {error && <p style={{ color: 'crimson' }}>Error: {error}</p>}
          {!loading && alerts.length === 0 && (
            <p style={{ color: 'var(--text-secondary, #666)', fontSize: 12 }}>
              No active alerts in this region. Insert a row into <code>EMERGENCY_RESPONSE.SOURCE.MOCK_ALERTS</code> to demo.
            </p>
          )}
          <ul style={{ listStyle: 'none', padding: 0, margin: 0 }}>
            {alerts.map(a => {
              const isSel = a.alertId === selectedAlertId;
              const hex = SEVERITY_HEX[a.severity] || '#777';
              return (
                <li
                  key={a.alertId}
                  onClick={() => onSelectAlert?.(a.alertId)}
                  style={{
                    cursor: 'pointer',
                    padding: 8,
                    marginBottom: 6,
                    borderLeft: `4px solid ${hex}`,
                    border: isSel ? `2px solid #29B5E8` : `1px solid var(--border, #eee)`,
                    borderLeftColor: hex,
                    borderLeftWidth: 4,
                    borderRadius: 4,
                    background: isSel ? 'rgba(41,181,232,0.08)' : 'transparent',
                  }}
                >
                  <strong style={{ color: hex }}>{a.eventType}</strong>
                  <span style={{ fontSize: 11, marginLeft: 6, color: 'var(--text-secondary, #777)' }}>{a.severity}</span>
                  <div style={{ fontSize: 11, color: 'var(--text, #333)', marginTop: 2 }}>{a.headline}</div>
                  <div style={{ fontSize: 10, color: 'var(--text-secondary, #999)', marginTop: 2 }}>
                    Expires: {fmtTime(a.expiresTime)}
                  </div>
                </li>
              );
            })}
          </ul>
        </aside>

        {/* Map */}
        <main>
          <EmergencyMap
            layers={layers}
            fitCoords={fitCoords}
            getTooltip={getTooltip}
          />
        </main>
      </div>
    </div>
  );
}

function Kpi({ label, value, accent }: { label: string; value: any; accent?: string }) {
  return (
    <div style={{
      flex: 1,
      padding: '10px 14px',
      border: '1px solid var(--border, #ddd)',
      borderTop: `3px solid ${accent || '#29B5E8'}`,
      borderRadius: 6,
      background: 'var(--card, #fff)',
    }}>
      <div style={{ fontSize: 11, color: 'var(--text-secondary, #666)' }}>{label}</div>
      <div style={{ fontSize: 22, fontWeight: 600 }}>{value}</div>
    </div>
  );
}

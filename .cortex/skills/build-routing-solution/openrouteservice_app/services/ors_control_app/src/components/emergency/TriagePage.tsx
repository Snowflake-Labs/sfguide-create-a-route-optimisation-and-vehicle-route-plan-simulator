// Page 2 -- Participant Triage
// Replaces Tyler's manual ArcGIS workflow: ranked impacted participants with
// vulnerability score, requires-lift filter, sortable columns, CSV export,
// and a live map of impacted points colored by vulnerability.

import { useEffect, useMemo, useState } from 'react';
import { GeoJsonLayer, ScatterplotLayer } from '@deck.gl/layers';
import EmergencyMap from './EmergencyMap';
import {
  fetchImpacted, fetchAlerts, exportCsvUrl,
  ImpactedParticipant, EmergencyAlert,
} from './helpers';

type Props = { selectedAlertId?: string };
type SortKey = 'compositeVulnerability' | 'milesFromAlertCentroid' | 'requiresLift' | 'participantId';

function vulnHex(v: number): string {
  if (v >= 80) return '#b71c1c';
  if (v >= 65) return '#e65100';
  if (v >= 50) return '#f9a825';
  return '#2e7d32';
}

function vulnRgba(v: number, a = 200): [number, number, number, number] {
  if (v >= 80) return [183, 28, 28, a];
  if (v >= 65) return [230, 81, 0, a];
  if (v >= 50) return [249, 168, 37, a];
  return [46, 125, 50, a];
}

export default function TriagePage({ selectedAlertId }: Props) {
  const [rows, setRows] = useState<ImpactedParticipant[]>([]);
  const [loading, setLoading] = useState(false);
  const [alert, setAlert] = useState<EmergencyAlert | null>(null);
  const [sortKey, setSortKey] = useState<SortKey>('compositeVulnerability');
  const [sortDir, setSortDir] = useState<'desc' | 'asc'>('desc');
  const [requiresLiftOnly, setRequiresLiftOnly] = useState(false);

  useEffect(() => {
    if (!selectedAlertId) return;
    setLoading(true);
    Promise.all([
      fetchImpacted(selectedAlertId),
      fetchAlerts(),
    ]).then(([rs, as]) => {
      setRows(rs);
      setAlert(as.find(a => a.alertId === selectedAlertId) || null);
    }).finally(() => setLoading(false));
  }, [selectedAlertId]);

  const filtered = useMemo(() => {
    let xs = rows;
    if (requiresLiftOnly) xs = xs.filter(r => r.requiresLift);
    const dir = sortDir === 'desc' ? -1 : 1;
    xs = [...xs].sort((a, b) => {
      const av = (a as any)[sortKey];
      const bv = (b as any)[sortKey];
      if (av === bv) return 0;
      return av > bv ? dir : -dir;
    });
    return xs;
  }, [rows, sortKey, sortDir, requiresLiftOnly]);

  const layers = useMemo(() => {
    const ll: any[] = [];
    if (alert?.boundaryGeoJson) {
      ll.push(new GeoJsonLayer({
        id: 'alert-poly',
        data: { type: 'Feature', geometry: alert.boundaryGeoJson, properties: {} } as any,
        getFillColor: [200, 60, 50, 50],
        getLineColor: [200, 60, 50, 220],
        lineWidthMinPixels: 2,
        stroked: true, filled: true,
      }));
    }
    if (filtered.length) {
      ll.push(new ScatterplotLayer({
        id: 'impacted',
        data: filtered,
        getPosition: (d: ImpactedParticipant) => d.loc,
        getRadius: 60,
        radiusMinPixels: 2,
        radiusMaxPixels: 6,
        getFillColor: (d: ImpactedParticipant) => vulnRgba(d.compositeVulnerability),
        pickable: true,
      }));
    }
    return ll;
  }, [alert, filtered]);

  const fitCoords = useMemo(() => filtered.slice(0, 500).map(r => r.loc as [number,number]), [filtered]);

  const getTooltip = (info: any) => {
    if (info?.object?.participantId) {
      const r = info.object as ImpactedParticipant;
      return {
        html: `<b>${r.participantId}</b><br/>Vulnerability: ${Math.round(r.compositeVulnerability)}<br/>${r.requiresLift ? 'Requires lift' : 'Standard transport'}<br/>${r.address}`,
        style: { backgroundColor: '#14141f', color: '#fff', padding: '8px', borderRadius: '4px', fontSize: 12 },
      };
    }
    return null;
  };

  const setSort = (k: SortKey) => {
    if (sortKey === k) setSortDir(d => d === 'desc' ? 'asc' : 'desc');
    else { setSortKey(k); setSortDir('desc'); }
  };

  if (!selectedAlertId) {
    return <p style={{ padding: 16 }}>Select an alert from the Hazard Operations Center first.</p>;
  }

  return (
    <div style={{ padding: 12, height: '100%', display: 'flex', flexDirection: 'column', gap: 12 }}>
      <header style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <div>
          <h3 style={{ margin: 0 }}>Impacted Participants -- {selectedAlertId}</h3>
          <span style={{ fontSize: 12, color: 'var(--text-secondary, #666)' }}>
            {loading ? 'Loading...' : `${filtered.length} participants${requiresLiftOnly ? ' (requires lift only)' : ''}`}
          </span>
        </div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <label style={{ fontSize: 12, display: 'flex', alignItems: 'center', gap: 4 }}>
            <input type="checkbox" checked={requiresLiftOnly} onChange={e => setRequiresLiftOnly(e.target.checked)} />
            Requires lift only
          </label>
          <a href={exportCsvUrl(selectedAlertId)} download style={{
            padding: '6px 12px', background: '#29B5E8', color: '#fff',
            textDecoration: 'none', borderRadius: 4, fontSize: 13,
          }}>Export CSV</a>
        </div>
      </header>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, flex: 1, minHeight: 0 }}>
        {/* Map */}
        <div style={{ minHeight: 400 }}>
          <EmergencyMap layers={layers} fitCoords={fitCoords} getTooltip={getTooltip} />
        </div>

        {/* Table */}
        <div style={{ overflowY: 'auto', border: '1px solid var(--border, #ddd)', borderRadius: 8 }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
            <thead style={{ position: 'sticky', top: 0, background: 'var(--card, #f5f5f5)', zIndex: 1 }}>
              <tr>
                <Th label="#"        sortable={false} />
                <Th label="ID"        sortKey="participantId"             current={sortKey} dir={sortDir} onSort={setSort} />
                <Th label="Vuln"      sortKey="compositeVulnerability"   current={sortKey} dir={sortDir} onSort={setSort} />
                <Th label="Lift?"     sortKey="requiresLift"             current={sortKey} dir={sortDir} onSort={setSort} />
                <Th label="Mi"        sortKey="milesFromAlertCentroid"   current={sortKey} dir={sortDir} onSort={setSort} />
                <Th label="Lang"     sortable={false} />
                <Th label="Address"  sortable={false} />
              </tr>
            </thead>
            <tbody>
              {filtered.slice(0, 1000).map((r, i) => (
                <tr key={r.participantId} style={{ borderBottom: '1px solid var(--border, #eee)' }}>
                  <td style={td}>{i + 1}</td>
                  <td style={td}>{r.participantId}</td>
                  <td style={{ ...td, fontWeight: 600, color: vulnHex(Number(r.compositeVulnerability)) }}>{Math.round(Number(r.compositeVulnerability))}</td>
                  <td style={td}>{r.requiresLift ? 'Yes' : 'No'}</td>
                  <td style={td}>{Number(r.milesFromAlertCentroid).toFixed(2)}</td>
                  <td style={td}>{r.primaryLanguage}</td>
                  <td style={{ ...td, fontSize: 11, color: 'var(--text-secondary, #555)' }}>{r.address}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {filtered.length > 1000 && (
            <div style={{ padding: 8, fontSize: 11, color: 'var(--text-secondary, #777)', textAlign: 'center' }}>
              Showing first 1,000 of {filtered.length}. Use CSV export for full list.
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

const td: React.CSSProperties = { padding: '4px 8px' };

function Th({ label, sortKey: key, current, dir, onSort, sortable = true }: any) {
  const active = sortable && current === key;
  return (
    <th
      onClick={() => sortable && onSort?.(key)}
      style={{
        textAlign: 'left',
        padding: '6px 8px',
        borderBottom: '2px solid var(--border, #ddd)',
        cursor: sortable ? 'pointer' : 'default',
        userSelect: 'none',
        whiteSpace: 'nowrap',
      }}
    >
      {label} {active ? (dir === 'desc' ? '↓' : '↑') : ''}
    </th>
  );
}

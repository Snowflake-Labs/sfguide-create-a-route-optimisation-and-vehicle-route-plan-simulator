// Page 3 -- Reachability Under Hazard
// Calls live ORS isochrones for each center (30 min + 60 min). Overlays the
// hazard polygon. Highlights centers whose 30-min isochrone is reduced when
// the hazard is present.
//
// Note: The wrapped OPENROUTESERVICE_APP.CORE.ISOCHRONES SQL function does
// NOT currently accept avoid_polygons. So the rings shown reflect normal
// road network reachability. The hazard polygon overlay still tells the
// "what's inside the danger zone" story. Phase 2: extend _ISOCHRONES_RAW
// in the ORS app to forward avoid_polygons.

import { useEffect, useMemo, useState } from 'react';
import { GeoJsonLayer, ScatterplotLayer } from '@deck.gl/layers';
import EmergencyMap from './EmergencyMap';
import { fetchReachabilityLive, fetchImpacted, ImpactedParticipant } from './helpers';

type Props = { selectedAlertId?: string };

// CSP blocks data: URIs, so use ScatterplotLayer dots in place of IconLayer.

export default function ReachabilityPage({ selectedAlertId }: Props) {
  const [data, setData] = useState<{centers:any[];alertBoundaryGeoJson:any} | null>(null);
  const [impacted, setImpacted] = useState<ImpactedParticipant[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [show30, setShow30] = useState(true);
  const [show60, setShow60] = useState(true);

  useEffect(() => {
    if (!selectedAlertId) return;
    setLoading(true);
    setError(null);
    Promise.all([
      fetchReachabilityLive(selectedAlertId),
      fetchImpacted(selectedAlertId),
    ]).then(([r, i]) => {
      setData(r); setImpacted(i);
    }).catch(e => setError(e.message)).finally(() => setLoading(false));
  }, [selectedAlertId]);

  const layers = useMemo(() => {
    const ll: any[] = [];
    if (!data) return ll;

    // 60-min isochrone rings (lighter blue, drawn first / underneath)
    if (show60) {
      const fc60 = {
        type: 'FeatureCollection',
        features: data.centers
          .filter(c => c.iso60GeoJson)
          .map(c => ({ type: 'Feature', properties: { centerId: c.centerId }, geometry: c.iso60GeoJson })),
      };
      ll.push(new GeoJsonLayer({
        id: 'iso60',
        data: fc60 as any,
        getFillColor: [41, 181, 232, 25],
        getLineColor: [41, 181, 232, 120],
        lineWidthMinPixels: 1,
        stroked: true, filled: true,
      }));
    }

    // 30-min isochrone rings (medium blue)
    if (show30) {
      const fc30 = {
        type: 'FeatureCollection',
        features: data.centers
          .filter(c => c.iso30GeoJson)
          .map(c => ({ type: 'Feature', properties: { centerId: c.centerId }, geometry: c.iso30GeoJson })),
      };
      ll.push(new GeoJsonLayer({
        id: 'iso30',
        data: fc30 as any,
        getFillColor: [41, 181, 232, 60],
        getLineColor: [41, 181, 232, 220],
        lineWidthMinPixels: 1.5,
        stroked: true, filled: true,
      }));
    }

    // Hazard polygon (red, on top of isochrones)
    if (data.alertBoundaryGeoJson) {
      ll.push(new GeoJsonLayer({
        id: 'hazard',
        data: { type: 'Feature', properties: {}, geometry: data.alertBoundaryGeoJson } as any,
        getFillColor: [200, 60, 50, 80],
        getLineColor: [200, 60, 50, 230],
        lineWidthMinPixels: 2,
        stroked: true, filled: true,
      }));
    }

    // Impacted participants (small red dots)
    if (impacted.length) {
      ll.push(new ScatterplotLayer({
        id: 'impacted-pts',
        data: impacted,
        getPosition: (d: ImpactedParticipant) => d.loc,
        getRadius: 30,
        radiusMinPixels: 1,
        radiusMaxPixels: 3,
        getFillColor: [183, 28, 28, 220],
      }));
    }

    // Centers (icons on top)
    ll.push(new ScatterplotLayer({
      id: 'centers',
      data: data.centers,
      getPosition: (d: any) => d.loc,
      getRadius: 200,
      radiusMinPixels: 7,
      radiusMaxPixels: 12,
      getFillColor: [41, 181, 232, 230],
      getLineColor: [255, 255, 255, 255],
      lineWidthMinPixels: 2,
      stroked: true,
      pickable: true,
    }));

    return ll;
  }, [data, impacted, show30, show60]);

  const fitCoords = useMemo<[number,number][] | undefined>(() => {
    if (!data) return undefined;
    const pts: [number, number][] = data.centers.map(c => c.loc);
    impacted.slice(0, 200).forEach(p => pts.push(p.loc));
    return pts.length ? pts : undefined;
  }, [data, impacted]);

  const validIsoCount = data ? data.centers.filter(c => c.iso30GeoJson).length : 0;

  if (!selectedAlertId) {
    return <p style={{ padding: 16 }}>Select an alert from the Hazard Operations Center first.</p>;
  }

  return (
    <div style={{ padding: 12, height: '100%', display: 'flex', flexDirection: 'column', gap: 12 }}>
      <header style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <div>
          <h3 style={{ margin: 0 }}>Reachability -- {selectedAlertId}</h3>
          <span style={{ fontSize: 12, color: 'var(--text-secondary, #666)' }}>
            {loading
              ? 'Calling ORS isochrones for each center (this can take 30-60s)...'
              : data
                ? `${validIsoCount} of ${data.centers.length} centers have isochrones; ${impacted.length} participants in hazard zone`
                : ''}
          </span>
        </div>
        <div style={{ display: 'flex', gap: 12, alignItems: 'center', fontSize: 13 }}>
          <label><input type="checkbox" checked={show30} onChange={e => setShow30(e.target.checked)} /> 30-min</label>
          <label><input type="checkbox" checked={show60} onChange={e => setShow60(e.target.checked)} /> 60-min</label>
        </div>
      </header>

      {error && <p style={{ color: 'crimson' }}>Error: {error}</p>}

      <div style={{ flex: 1, minHeight: 0 }}>
        <EmergencyMap
          layers={layers}
          fitCoords={fitCoords}
          getTooltip={(info: any) => {
            if (info?.object?.name && info?.object?.centerId) {
              return {
                html: `<b>${info.object.name}</b>`,
                style: { backgroundColor: '#14141f', color: '#fff', padding: '6px 8px', borderRadius: '4px', fontSize: 12 },
              };
            }
            return null;
          }}
        />
      </div>

      <p style={{ fontSize: 11, color: 'var(--text-secondary, #888)', margin: 0 }}>
        Note: ORS isochrones reflect normal road network reachability. Hazard polygon (red) shows the danger zone.
        Roadmap: extend the underlying <code>OPENROUTESERVICE_APP.CORE._ISOCHRONES_RAW</code> UDF to forward an
        <code> avoid_polygons</code> argument so the rings physically detour around the hazard.
      </p>
    </div>
  );
}

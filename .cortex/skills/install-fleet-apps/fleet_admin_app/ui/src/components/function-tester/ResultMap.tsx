'use client';
import { useMemo } from 'react';
import DeckGL from '@deck.gl/react';
import { ScatterplotLayer, GeoJsonLayer, PathLayer, IconLayer, TextLayer } from '@deck.gl/layers';
import { PathStyleExtension } from '@deck.gl/extensions';
import Basemap from '@/components/shared/basemap';
import {
  GeoData, OptimizationParsed, OPTIMIZATION_PALETTE,
  extractGeoData, parseMatrixResult, parseOptimizationResult, travelTimeColor,
  parseIsochroneOrigin, parseSnapResult,
} from './helpers';
import { useFitMap, isFiniteVS } from '@/components/shared/useFitMap';
import RecenterButton from '@/components/shared/RecenterButton';
import { useRegion } from '@/hooks/useRegion';
import { coordsFromGeoJSON, type LngLat } from '@/components/shared/mapFit';
import { decimateGeometry, decimateLineCoords } from '@fleet-kit/core/map';

interface RegionBbox { min_lat: number; max_lat: number; min_lon: number; max_lon: number }

export function ResultMap({
  result,
  fnName,
  regionCenter,
  regionBbox = null,
  regionBoundary = null,
  executedSql,
  trajectory = null,
}: {
  result: any;
  fnName: string;
  regionCenter: [number, number];
  regionBbox?: RegionBbox | null;
  regionBoundary?: any | null;
  executedSql: string;
  /** Noisy GPS track fed to MATCH / MATCH_PATH, drawn as the unmatched input. */
  trajectory?: [number, number][] | null;
}) {
  const geo = useMemo(() => extractGeoData(result), [result]);
  const matrix = useMemo(() => (fnName === 'MATRIX' || fnName === 'MATRIX_TABULAR') ? parseMatrixResult(result) : null, [result, fnName]);
  const optimization = useMemo(() => fnName === 'OPTIMIZATION' ? parseOptimizationResult(result) : null, [result, fnName]);
  const snap = useMemo(() => fnName === 'SNAP_POINTS' ? parseSnapResult(result) : [], [result, fnName]);

  const geojsonLayer = useMemo(() => {
    if (!geo.geojson) return null;
    // Decimate line geometry so heavy directions/route results do not freeze the
    // map; points/polygons are left intact (shared @fleet-kit decimation).
    const data = {
      ...geo.geojson,
      features: geo.geojson.features.map((f: any) =>
        f?.geometry ? { ...f, geometry: decimateGeometry(f.geometry) } : f,
      ),
    };
    return new GeoJsonLayer({
      id: 'result-geojson',
      data,
      pickable: true,
      stroked: true,
      filled: true,
      extruded: false,
      lineWidthMinPixels: 3,
      getLineColor: [255, 107, 53, 220],
      getFillColor: [255, 107, 53, 60],
      getLineWidth: 3,
      pointRadiusMinPixels: 6,
      getPointRadius: 80,
      pointType: 'circle',
    });
  }, [geo.geojson]);

  const startEndLayer = useMemo(() => {
    if (!geo.geojson) return null;
    const markers: { position: [number, number]; color: [number, number, number, number]; label: string }[] = [];
    for (const f of geo.geojson.features) {
      const geom = f.geometry;
      if (geom?.type === 'LineString' && geom.coordinates.length > 1) {
        markers.push({ position: geom.coordinates[0], color: [48, 209, 88, 255], label: 'Start' });
        markers.push({ position: geom.coordinates[geom.coordinates.length - 1], color: [255, 59, 48, 255], label: 'End' });
      }
    }
    if (markers.length === 0) return null;
    return new ScatterplotLayer({
      id: 'start-end-markers',
      data: markers,
      pickable: true,
      getPosition: (d: any) => d.position,
      getFillColor: (d: any) => d.color,
      getLineColor: [255, 255, 255, 200],
      getRadius: 80,
      radiusMinPixels: 7,
      radiusMaxPixels: 12,
      stroked: true,
      lineWidthMinPixels: 2,
    });
  }, [geo.geojson]);

  const pointsLayer = useMemo(() => {
    if (geo.points.length === 0) return null;
    return new ScatterplotLayer({
      id: 'matrix-points',
      data: geo.points.map((p) => ({ position: p })),
      pickable: true,
      getPosition: (d: any) => d.position,
      getFillColor: [255, 149, 0, 220],
      getLineColor: [255, 255, 255, 200],
      getRadius: 80,
      radiusMinPixels: 6,
      radiusMaxPixels: 10,
      stroked: true,
      lineWidthMinPixels: 2,
    });
  }, [geo.points]);

  const isoOrigin = useMemo(
    () => fnName === 'ISOCHRONES' ? parseIsochroneOrigin(executedSql) : null,
    [fnName, executedSql],
  );

  const isoOriginLayer = useMemo(() => {
    if (!isoOrigin) return null;
    return new ScatterplotLayer({
      id: 'iso-origin',
      data: [{ position: isoOrigin, label: 'Origin' }],
      pickable: true,
      getPosition: (d: any) => d.position,
      getFillColor: [245, 158, 11, 255],
      getLineColor: [255, 255, 255, 255],
      getRadius: 120,
      radiusMinPixels: 9,
      radiusMaxPixels: 14,
      stroked: true,
      lineWidthMinPixels: 3,
    });
  }, [isoOrigin]);

  // SNAP: the value is the correction, so draw input, snapped point, and the
  // connector between them rather than a single marker per row.
  const snapLayers = useMemo(() => {
    if (snap.length === 0) return [];
    const connectors = snap
      .filter((r) => r.snapped)
      .map((r) => ({ path: [r.input, r.snapped!], idx: r.idx, distanceM: r.distanceM }));
    const layers: any[] = [];
    if (connectors.length > 0) {
      layers.push(new PathLayer({
        id: 'snap-connectors',
        data: connectors,
        pickable: true,
        getPath: (d: any) => d.path,
        getColor: [148, 163, 184, 220],
        getWidth: 3,
        widthMinPixels: 2,
        widthMaxPixels: 4,
      }));
    }
    layers.push(new ScatterplotLayer({
      id: 'snap-inputs',
      data: snap,
      pickable: true,
      getPosition: (d: any) => d.input,
      getFillColor: (d: any) => (d.snapped ? [148, 163, 184, 230] : [239, 68, 68, 240]),
      getLineColor: [255, 255, 255, 220],
      getRadius: 70,
      radiusMinPixels: 5,
      radiusMaxPixels: 9,
      stroked: true,
      lineWidthMinPixels: 2,
    }));
    layers.push(new ScatterplotLayer({
      id: 'snap-snapped',
      data: snap.filter((r) => r.snapped),
      pickable: true,
      getPosition: (d: any) => d.snapped,
      getFillColor: [48, 209, 88, 240],
      getLineColor: [255, 255, 255, 240],
      getRadius: 100,
      radiusMinPixels: 7,
      radiusMaxPixels: 12,
      stroked: true,
      lineWidthMinPixels: 2,
    }));
    return layers;
  }, [snap]);

  // MATCH / MATCH_PATH: the input track is what makes the matched road visible
  // as a correction; without it the result looks like an ordinary route.
  const trajectoryLayer = useMemo(() => {
    if (!trajectory || trajectory.length < 2) return null;
    if (fnName !== 'MATCH' && fnName !== 'MATCH_PATH') return null;
    return new PathLayer({
      id: 'match-input-track',
      data: [{ path: trajectory }],
      pickable: true,
      getPath: (d: any) => d.path,
      getColor: [148, 163, 184, 200],
      getWidth: 3,
      widthMinPixels: 2,
      widthMaxPixels: 4,
      getDashArray: [6, 4],
      dashJustified: true,
      extensions: [new PathStyleExtension({ dash: true })],
    });
  }, [trajectory, fnName]);

  const trajectoryPointsLayer = useMemo(() => {
    if (!trajectory || trajectory.length === 0) return null;
    if (fnName !== 'MATCH' && fnName !== 'MATCH_PATH') return null;
    return new ScatterplotLayer({
      id: 'match-input-fixes',
      data: trajectory.map((p, i) => ({ position: p, label: `GPS fix ${i + 1}` })),
      pickable: true,
      getPosition: (d: any) => d.position,
      getFillColor: [148, 163, 184, 230],
      getLineColor: [255, 255, 255, 200],
      getRadius: 45,
      radiusMinPixels: 3,
      radiusMaxPixels: 6,
      stroked: true,
      lineWidthMinPixels: 1,
    });
  }, [trajectory, fnName]);

  const matrixLayers = useMemo(() => {
    if (!matrix) return [];
    const layers: any[] = [];
    const allDurations = matrix.durations.flat();
    const maxT = Math.max(...allDurations, 1);
    const destData = matrix.destinations
      .map((d: any, i: number) => ({
        position: d.location as [number, number],
        name: d.name || `Dest ${i + 1}`,
        duration: matrix.durations[0]?.[i] ?? 0,
        distance: matrix.distances[0]?.[i] ?? 0,
      }))
      .filter((d: any) => d.position);
    layers.push(new ScatterplotLayer({
      id: 'matrix-destinations',
      data: destData,
      pickable: true,
      getPosition: (d: any) => d.position,
      getFillColor: (d: any) => travelTimeColor(d.duration, maxT),
      getLineColor: [255, 255, 255, 200],
      getRadius: 120,
      radiusMinPixels: 10,
      radiusMaxPixels: 18,
      stroked: true,
      lineWidthMinPixels: 2,
    }));
    const srcData = matrix.sources.filter((s: any) => s.location).map((s: any) => ({ position: s.location as [number, number], name: s.name || 'Origin' }));
    layers.push(new ScatterplotLayer({
      id: 'matrix-origins',
      data: srcData,
      pickable: true,
      getPosition: (d: any) => d.position,
      getFillColor: [245, 158, 11, 255],
      getLineColor: [255, 255, 255, 255],
      getRadius: 140,
      radiusMinPixels: 12,
      radiusMaxPixels: 20,
      stroked: true,
      lineWidthMinPixels: 3,
    }));
    return layers;
  }, [matrix]);

  const optimizationLayers = useMemo(() => {
    if (!optimization) return [];
    const layers: any[] = [];
    const stopData: { position: [number, number]; vehicleId: number; jobId?: number; color: [number, number, number, number] }[] = [];
    for (const v of optimization.vehicles) {
      const color = OPTIMIZATION_PALETTE[(v.vehicleId - 1) % OPTIMIZATION_PALETTE.length];
      for (const s of v.stops) {
        stopData.push({ position: s.position, vehicleId: v.vehicleId, jobId: s.jobId, color });
      }
    }
    layers.push(new PathLayer({
      id: 'optimization-paths',
      data: optimization.vehicles.filter(v => v.path.length > 1),
      pickable: true,
      getPath: (v: any) => decimateLineCoords(v.path) as any,
      getColor: (v: any) => OPTIMIZATION_PALETTE[(v.vehicleId - 1) % OPTIMIZATION_PALETTE.length],
      getWidth: 5,
      widthMinPixels: 4,
      widthMaxPixels: 8,
      capRounded: true,
      jointRounded: true,
    }));
    layers.push(new ScatterplotLayer({
      id: 'optimization-stops',
      data: stopData,
      pickable: true,
      getPosition: (d: any) => d.position,
      getFillColor: (d: any) => d.color,
      getLineColor: [255, 255, 255, 230],
      getRadius: 90,
      radiusMinPixels: 7,
      radiusMaxPixels: 12,
      stroked: true,
      lineWidthMinPixels: 2,
    }));
    if (optimization.depot) {
      layers.push(new ScatterplotLayer({
        id: 'optimization-depot',
        data: [{ position: optimization.depot }],
        pickable: true,
        getPosition: (d: any) => d.position,
        getFillColor: [255, 255, 255, 255],
        getLineColor: [20, 20, 31, 255],
        getRadius: 140,
        radiusMinPixels: 10,
        radiusMaxPixels: 16,
        stroked: true,
        lineWidthMinPixels: 3,
      }));
    }
    return layers;
  }, [optimization]);

  const layers = useMemo(() => optimization
    ? optimizationLayers
    : matrix
      ? matrixLayers
      : snapLayers.length > 0
        ? snapLayers
        : [geojsonLayer, isoOriginLayer, startEndLayer, pointsLayer, trajectoryLayer, trajectoryPointsLayer].filter(Boolean),
    [optimization, optimizationLayers, matrix, matrixLayers, snapLayers, geojsonLayer, isoOriginLayer, startEndLayer, pointsLayer, trajectoryLayer, trajectoryPointsLayer]);

  const hasGeo = !!(geo.geojson || geo.points.length > 0 || matrix || optimization || snap.length > 0 || trajectoryLayer);

  const isFinitePt = (p: any): p is LngLat =>
    Array.isArray(p) && p.length >= 2 && Number.isFinite(p[0]) && Number.isFinite(p[1]);

  const resultCoords = useMemo<LngLat[]>(() => {
    const out: LngLat[] = [];
    if (optimization) {
      for (const v of optimization.vehicles) {
        for (const p of v.path) out.push([p[0], p[1]]);
        for (const s of v.stops) out.push([s.position[0], s.position[1]]);
      }
      if (optimization.depot) out.push([optimization.depot[0], optimization.depot[1]]);
    } else if (matrix) {
      for (const s of matrix.sources) if (s.location) out.push([s.location[0], s.location[1]]);
      for (const d of matrix.destinations) if (d.location) out.push([d.location[0], d.location[1]]);
    } else if (snap.length > 0) {
      for (const r of snap) {
        out.push([r.input[0], r.input[1]]);
        if (r.snapped) out.push([r.snapped[0], r.snapped[1]]);
      }
    } else {
      if (geo.geojson) out.push(...coordsFromGeoJSON(geo.geojson));
      for (const p of geo.points) out.push([p[0], p[1]]);
      if (isoOrigin) out.push([isoOrigin[0], isoOrigin[1]]);
      if (trajectoryLayer && trajectory) for (const p of trajectory) out.push([p[0], p[1]]);
    }
    return out.filter(isFinitePt);
  }, [optimization, matrix, snap, geo, isoOrigin, trajectory, trajectoryLayer]);

  const presetCoords = useMemo<LngLat[]>(() => {
    if (regionBoundary) {
      const c = coordsFromGeoJSON(regionBoundary).filter(isFinitePt);
      if (c.length > 0) return c;
    }
    if (regionBbox) {
      const { min_lat, max_lat, min_lon, max_lon } = regionBbox;
      const corners: LngLat[] = [
        [min_lon, min_lat],
        [max_lon, min_lat],
        [max_lon, max_lat],
        [min_lon, max_lat],
      ];
      const valid = corners.filter(isFinitePt);
      const allZero = min_lat === 0 && max_lat === 0 && min_lon === 0 && max_lon === 0;
      if (valid.length === 4 && !allZero) return valid;
    }
    return [];
  }, [regionBoundary, regionBbox]);

  const fitCoords = useMemo<LngLat[]>(
    () => (resultCoords.length > 0 ? resultCoords : presetCoords),
    [resultCoords, presetCoords],
  );

  const fallback = useMemo(() => {
    const lon = Number.isFinite(regionCenter?.[0]) ? regionCenter[0] : 0;
    const lat = Number.isFinite(regionCenter?.[1]) ? regionCenter[1] : 30;
    const hasCenter = Number.isFinite(regionCenter?.[0]) && Number.isFinite(regionCenter?.[1]) && !(regionCenter[0] === 0 && regionCenter[1] === 0);
    return { longitude: lon, latitude: lat, zoom: hasCenter ? 12 : 2, pitch: 0, bearing: 0 };
  }, [regionCenter]);
  const { regionName } = useRegion();
  const { containerRef, dims, viewState, onViewStateChange, recenter } = useFitMap(fitCoords, { fallback, regionKey: regionName });

  const getTooltip = ({ object, layer }: any) => {
    if (!object) return null;
    if (layer?.id === 'matrix-origins') return { text: object.name, style: { background: '#14141f', color: '#e8e8f0', fontSize: '12px', padding: '4px 8px', borderRadius: '4px' } };
    if (layer?.id === 'iso-origin') return { text: object.label, style: { background: '#14141f', color: '#e8e8f0', fontSize: '12px', padding: '4px 8px', borderRadius: '4px' } };
    if (layer?.id === 'matrix-destinations') {
      return { text: `${object.name}\n${(object.duration / 60).toFixed(1)} min · ${(object.distance / 1000).toFixed(2)} km`, style: { background: '#14141f', color: '#e8e8f0', fontSize: '12px', padding: '6px 10px', borderRadius: '4px', whiteSpace: 'pre-line' } };
    }
    if (layer?.id === 'start-end-markers') {
      return { text: object.label, style: { background: '#14141f', color: '#e8e8f0', fontSize: '12px', padding: '4px 8px', borderRadius: '4px' } };
    }
    if (layer?.id === 'optimization-paths') {
      return { text: `Vehicle ${object.vehicleId}`, style: { background: '#14141f', color: '#e8e8f0', fontSize: '12px', padding: '4px 8px', borderRadius: '4px' } };
    }
    if (layer?.id === 'optimization-stops') {
      const job = object.jobId != null ? ` · Job ${object.jobId}` : '';
      return { text: `Vehicle ${object.vehicleId}${job}`, style: { background: '#14141f', color: '#e8e8f0', fontSize: '12px', padding: '4px 8px', borderRadius: '4px' } };
    }
    if (layer?.id === 'optimization-depot') {
      return { text: 'Depot', style: { background: '#14141f', color: '#e8e8f0', fontSize: '12px', padding: '4px 8px', borderRadius: '4px' } };
    }
    if (layer?.id === 'snap-inputs') {
      const dist = object.distanceM != null ? `${object.distanceM} m off road` : 'not snapped (outside radius)';
      return { text: `Input ${object.idx}\n${dist}`, style: { background: '#14141f', color: '#e8e8f0', fontSize: '12px', padding: '6px 10px', borderRadius: '4px', whiteSpace: 'pre-line' } };
    }
    if (layer?.id === 'snap-snapped') {
      const name = object.name ? `${object.name}\n` : '';
      return { text: `${name}Snapped ${object.distanceM ?? '?'} m`, style: { background: '#14141f', color: '#e8e8f0', fontSize: '12px', padding: '6px 10px', borderRadius: '4px', whiteSpace: 'pre-line' } };
    }
    if (layer?.id === 'match-input-fixes') {
      return { text: object.label, style: { background: '#14141f', color: '#e8e8f0', fontSize: '12px', padding: '4px 8px', borderRadius: '4px' } };
    }
    if (layer?.id === 'match-input-track') {
      return { text: 'Raw GPS track (input)', style: { background: '#14141f', color: '#e8e8f0', fontSize: '12px', padding: '4px 8px', borderRadius: '4px' } };
    }
    if (layer?.id === 'result-geojson' && object.properties) {
      const props = object.properties;
      const parts: string[] = [];
      if (props.distance) parts.push(`Distance: ${(props.distance / 1000).toFixed(1)} km`);
      if (props.duration) parts.push(`Duration: ${(props.duration / 60).toFixed(1)} min`);
      if (props.value) parts.push(`Range: ${props.value} min`);
      if (parts.length === 0) return null;
      return { text: parts.join('\n'), style: { background: '#14141f', color: '#e8e8f0', fontSize: '12px', padding: '6px 10px', borderRadius: '4px', whiteSpace: 'pre-line' } };
    }
    return null;
  };

  return (
    <div style={{ marginTop: 16 }}>
      <h3>Map</h3>
      {!hasGeo && <p style={{ color: 'var(--text-secondary)', fontSize: 13, margin: '0 0 8px' }}>No spatial data to display. Run a geo function to see results on the map.</p>}
      {matrix && (
        <div style={{ display: 'flex', gap: 12, marginBottom: 8, fontSize: 12, alignItems: 'center' }}>
          <span style={{ display: 'flex', alignItems: 'center', gap: 4 }}><span style={{ width: 12, height: 12, borderRadius: '50%', background: 'rgb(245,158,11)', display: 'inline-block' }} /> Origin</span>
          <span style={{ display: 'flex', alignItems: 'center', gap: 4 }}><span style={{ width: 12, height: 12, borderRadius: '50%', background: 'rgb(34,197,94)', display: 'inline-block' }} /> Fast</span>
          <span style={{ display: 'flex', alignItems: 'center', gap: 4 }}><span style={{ width: 12, height: 12, borderRadius: '50%', background: 'rgb(239,68,68)', display: 'inline-block' }} /> Slow</span>
        </div>
      )}
      {!matrix && fnName === 'ISOCHRONES' && isoOrigin && (
        <div style={{ display: 'flex', gap: 12, marginBottom: 8, fontSize: 12, alignItems: 'center' }}>
          <span style={{ display: 'flex', alignItems: 'center', gap: 4 }}><span style={{ width: 12, height: 12, borderRadius: '50%', background: 'rgb(245,158,11)', display: 'inline-block' }} /> Origin</span>
          <span style={{ display: 'flex', alignItems: 'center', gap: 4 }}><span style={{ width: 12, height: 12, background: 'rgba(255,107,53,0.4)', border: '2px solid rgb(255,107,53)', display: 'inline-block' }} /> Reachable area</span>
        </div>
      )}
      {snap.length > 0 && (
        <div style={{ display: 'flex', gap: 12, marginBottom: 8, fontSize: 12, alignItems: 'center', flexWrap: 'wrap' }}>
          <span style={{ display: 'flex', alignItems: 'center', gap: 4 }}><span style={{ width: 12, height: 12, borderRadius: '50%', background: 'rgb(148,163,184)', display: 'inline-block' }} /> Input point</span>
          <span style={{ display: 'flex', alignItems: 'center', gap: 4 }}><span style={{ width: 12, height: 12, borderRadius: '50%', background: 'rgb(48,209,88)', display: 'inline-block' }} /> Snapped to road</span>
          {snap.some((r) => !r.snapped) && (
            <span style={{ display: 'flex', alignItems: 'center', gap: 4 }}><span style={{ width: 12, height: 12, borderRadius: '50%', background: 'rgb(239,68,68)', display: 'inline-block' }} /> Not snapped</span>
          )}
        </div>
      )}
      {trajectoryLayer && (
        <div style={{ display: 'flex', gap: 12, marginBottom: 8, fontSize: 12, alignItems: 'center', flexWrap: 'wrap' }}>
          <span style={{ display: 'flex', alignItems: 'center', gap: 4 }}><span style={{ width: 14, height: 3, background: 'rgb(148,163,184)', display: 'inline-block' }} /> Raw GPS track (input)</span>
          {/* Only advertise the orange key when matched geometry is actually on
              the map. The scalar MATCH returns edge ids and no geometry at all,
              and MATCH_PATH returns a NULL GEOJSON when the graph lacks the
              OsmId ext storage - in both cases the legend used to promise a red
              line that could never appear, which reads as a broken map. */}
          {geojsonLayer
            ? <span style={{ display: 'flex', alignItems: 'center', gap: 4 }}><span style={{ width: 14, height: 3, background: 'rgb(255,107,53)', display: 'inline-block' }} /> Matched road geometry</span>
            : fnName === 'MATCH'
              ? <span style={{ color: '#94a3b8' }}>MATCH returns edge ids only - use MATCH_PATH for road geometry</span>
              : <span style={{ color: '#f59e0b' }}>
                  No matched geometry returned. MATCH_PATH resolves edge ids to roads via the /export
                  TopoJSON, which only carries ors_ids when the profile graph was built with the OsmId
                  ext storage. Check ORS_STATUS(region):profiles.&lt;profile&gt;.storages.
                </span>}
        </div>
      )}
      {optimization && (
        <div style={{ display: 'flex', gap: 12, marginBottom: 8, fontSize: 12, alignItems: 'center', flexWrap: 'wrap' }}>
          {optimization.vehicles.map(v => {
            const c = OPTIMIZATION_PALETTE[(v.vehicleId - 1) % OPTIMIZATION_PALETTE.length];
            return (
              <span key={v.vehicleId} style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                <span style={{ width: 12, height: 12, borderRadius: '50%', background: `rgb(${c[0]},${c[1]},${c[2]})`, display: 'inline-block' }} /> Vehicle {v.vehicleId} ({v.stops.length} stops)
              </span>
            );
          })}
          {optimization.depot && (
            <span style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
              <span style={{ width: 12, height: 12, borderRadius: '50%', background: '#fff', border: '2px solid #14141f', display: 'inline-block' }} /> Depot
            </span>
          )}
        </div>
      )}
      <div ref={containerRef} style={{ height: 450, borderRadius: 8, border: '1px solid var(--border)', overflow: 'hidden', position: 'relative', background: '#e8e8e8' }}>
        {dims && isFiniteVS(viewState) ? (
          <>
            <Basemap viewState={viewState} />
            <DeckGL
              viewState={viewState}
              onViewStateChange={onViewStateChange}
              controller={true}
              layers={layers}
              getTooltip={getTooltip}
              style={{ width: '100%', height: '100%' }}
            />
          </>
        ) : null}
        <RecenterButton onClick={recenter} disabled={!fitCoords.length} />
      </div>
    </div>
  );
}

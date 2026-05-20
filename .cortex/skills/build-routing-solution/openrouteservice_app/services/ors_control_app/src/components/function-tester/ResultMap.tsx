import { useMemo, useState, useEffect } from 'react';
import DeckGL from '@deck.gl/react';
import { ScatterplotLayer, GeoJsonLayer, PathLayer, IconLayer, TextLayer } from '@deck.gl/layers';
import { TileLayer } from '@deck.gl/geo-layers';
import { BitmapLayer } from '@deck.gl/layers';
import {
  GeoData, OptimizationParsed, OPTIMIZATION_PALETTE, cartoBasemap,
  extractGeoData, parseMatrixResult, parseOptimizationResult, travelTimeColor,
  parseIsochroneOrigin,
} from './helpers';

export function ResultMap({ result, fnName, regionCenter, executedSql }: { result: any; fnName: string; regionCenter: [number, number]; executedSql: string }) {
  const geo = useMemo(() => extractGeoData(result), [result]);
  const matrix = useMemo(() => (fnName === 'MATRIX' || fnName === 'MATRIX_TABULAR') ? parseMatrixResult(result) : null, [result, fnName]);
  const optimization = useMemo(() => fnName === 'OPTIMIZATION' ? parseOptimizationResult(result) : null, [result, fnName]);
  const [viewState, setViewState] = useState({ longitude: regionCenter[0], latitude: regionCenter[1], zoom: 12, pitch: 0, bearing: 0 });

  useEffect(() => {
    if (optimization) {
      const allPts: [number, number][] = [];
      for (const v of optimization.vehicles) {
        allPts.push(...v.path);
        allPts.push(...v.stops.map(s => s.position));
      }
      if (optimization.depot) allPts.push(optimization.depot);
      if (allPts.length > 0) {
        const lons = allPts.map(p => p[0]);
        const lats = allPts.map(p => p[1]);
        const minLon = Math.min(...lons), maxLon = Math.max(...lons);
        const minLat = Math.min(...lats), maxLat = Math.max(...lats);
        const span = Math.max(maxLon - minLon, maxLat - minLat);
        let zoom = 12;
        if (span > 1) zoom = 8;
        else if (span > 0.5) zoom = 9;
        else if (span > 0.1) zoom = 11;
        else if (span > 0.02) zoom = 13;
        setViewState(prev => ({ ...prev, longitude: (minLon + maxLon) / 2, latitude: (minLat + maxLat) / 2, zoom }));
      }
      return;
    }
    if (matrix && matrix.sources.length > 0) {
      const allPts = [...matrix.sources, ...matrix.destinations].filter(p => p.location);
      if (allPts.length > 0) {
        const lons = allPts.map((p: any) => p.location[0]);
        const lats = allPts.map((p: any) => p.location[1]);
        setViewState(prev => ({ ...prev, longitude: (Math.min(...lons) + Math.max(...lons)) / 2, latitude: (Math.min(...lats) + Math.max(...lats)) / 2, zoom: 12 }));
      }
    } else if (geo.center) {
      setViewState((prev) => ({ ...prev, longitude: geo.center![0], latitude: geo.center![1], zoom: geo.zoom }));
    }
  }, [geo, matrix, optimization]);

  const geojsonLayer = useMemo(() => {
    if (!geo.geojson) return null;
    return new GeoJsonLayer({
      id: 'result-geojson',
      data: geo.geojson,
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
      getPath: (v: any) => v.path,
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

  const basemap = useMemo(() => cartoBasemap(), []);
  const layers = useMemo(() => optimization
    ? [basemap, ...optimizationLayers]
    : matrix
      ? [basemap, ...matrixLayers]
      : [basemap, geojsonLayer, isoOriginLayer, startEndLayer, pointsLayer].filter(Boolean),
    [basemap, optimization, optimizationLayers, matrix, matrixLayers, geojsonLayer, isoOriginLayer, startEndLayer, pointsLayer]);

  const hasGeo = !!(geo.geojson || geo.points.length > 0 || matrix || optimization);

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
      <div style={{ height: 450, borderRadius: 8, border: '1px solid var(--border)', overflow: 'hidden', position: 'relative', background: '#e8e8e8' }}>
        <DeckGL
          viewState={viewState}
          onViewStateChange={({ viewState: vs }: any) => setViewState(vs)}
          controller={true}
          layers={layers}
          getTooltip={getTooltip}
          style={{ width: '100%', height: '100%' }}
        />
      </div>
    </div>
  );
}

'use client';

// Inline map for routing tool results in chat. The exact ORS/VROOM response
// shape varies per tool, so this component defensively deep-scans the tool
// output for any GeoJSON (FeatureCollection / Feature / bare geometry, including
// JSON embedded in strings) and renders it with a single deck.gl GeoJsonLayer
// (which handles points, lines, and polygons uniformly). Registered for the
// User routing tools so directions / isochrones / POIs / catchments render as a
// map instead of raw JSON.

import { useMemo } from 'react';
import { GeoJsonLayer } from '@deck.gl/layers';
import type { Layer } from '@deck.gl/core';
import MapView from '../views/areas/map-view';
import { coordsFromGeoJSON, type LngLat } from '@/lib/map/map-fit';

function looksLikeGeoJSONString(s: string): boolean {
  const t = s.trim();
  return t.startsWith('{') && (t.includes('"coordinates"') || t.includes('"FeatureCollection"') || t.includes('"geometry"'));
}

function collectFeatures(node: unknown, out: GeoJSON.Feature[], depth = 0): void {
  if (node == null || depth > 8) return;
  if (typeof node === 'string') {
    if (looksLikeGeoJSONString(node)) {
      try { collectFeatures(JSON.parse(node), out, depth + 1); } catch { /* not json */ }
    }
    return;
  }
  if (Array.isArray(node)) {
    for (const item of node) collectFeatures(item, out, depth + 1);
    return;
  }
  if (typeof node === 'object') {
    const o = node as Record<string, unknown>;
    if (o.type === 'FeatureCollection' && Array.isArray(o.features)) {
      out.push(...(o.features as GeoJSON.Feature[]));
      return;
    }
    if (o.type === 'Feature' && o.geometry) {
      out.push(o as unknown as GeoJSON.Feature);
      return;
    }
    if (typeof o.type === 'string' && o.coordinates) {
      out.push({ type: 'Feature', geometry: o as unknown as GeoJSON.Geometry, properties: {} });
      return;
    }
    for (const v of Object.values(o)) collectFeatures(v, out, depth + 1);
  }
}

export function RouteMapInline(props: Record<string, unknown>) {
  const features = useMemo(() => {
    const out: GeoJSON.Feature[] = [];
    collectFeatures(props, out);
    return out;
  }, [props]);

  const fc = useMemo<GeoJSON.FeatureCollection>(
    () => ({ type: 'FeatureCollection', features }),
    [features],
  );

  const fitCoords = useMemo<LngLat[]>(() => coordsFromGeoJSON(fc), [fc]);

  // A stable token for the current result geometry. Each new computed result
  // (directions / isochrone / VRP) changes the token, which makes MapView
  // re-frame the camera on the fresh result even after the user has panned.
  const focusKey = useMemo(() => {
    if (fitCoords.length === 0) return '';
    const first = fitCoords[0];
    const last = fitCoords[fitCoords.length - 1];
    return `${fitCoords.length}:${first[0]},${first[1]}:${last[0]},${last[1]}`;
  }, [fitCoords]);

  const layers = useMemo<Layer[]>(() => {
    if (features.length === 0) return [];
    return [
      new GeoJsonLayer({
        id: 'inline-geojson',
        data: fc,
        filled: true,
        stroked: true,
        getFillColor: [41, 181, 232, 60],
        getLineColor: [41, 181, 232, 220],
        getLineWidth: 3,
        lineWidthMinPixels: 2,
        pointType: 'circle',
        getPointRadius: 60,
        pointRadiusMinPixels: 4,
        pointRadiusMaxPixels: 10,
      }),
    ];
  }, [features, fc]);

  if (features.length === 0) {
    return (
      <div style={{ padding: '12px', fontSize: '13px', color: 'var(--text-secondary, #6b7280)' }}>
        No map geometry in this result.
      </div>
    );
  }

  return (
    <div style={{ position: 'relative', width: '100%', height: 360, borderRadius: '8px', overflow: 'hidden', border: '1px solid var(--border-default, #e5e7eb)' }}>
      <MapView layers={layers} fitTo={{ coords: fitCoords, focusKey }} />
    </div>
  );
}

// Semantic alias: isochrone/catchment results render with the same component.
export const IsochroneInline = RouteMapInline;

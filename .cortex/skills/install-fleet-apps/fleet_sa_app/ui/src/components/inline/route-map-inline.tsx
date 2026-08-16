'use client';

// Inline map for routing tool results in chat. The exact ORS/VROOM response
// shape varies per tool, so this component defensively deep-scans the tool
// output for any GeoJSON (FeatureCollection / Feature / bare geometry, including
// JSON embedded in strings) and renders it with a single deck.gl GeoJsonLayer
// (which handles points, lines, and polygons uniformly). Registered for the
// User routing tools so directions / isochrones / POIs / catchments render as a
// map instead of raw JSON.

import { useCallback, useMemo } from 'react';
import { GeoJsonLayer } from '@deck.gl/layers';
import type { Layer } from '@deck.gl/core';
import MapView from '../views/areas/map-view';
import { coordsFromGeoJSON, type LngLat } from '@/lib/map/map-fit';
import { decimateGeometry } from '@/lib/map/layer-compiler';

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

  // Decimate line geometry so a heavy directions/VRP result (thousands of road
  // vertices) does not freeze the inline map; points/polygons pass through.
  const fc = useMemo<GeoJSON.FeatureCollection>(
    () => ({
      type: 'FeatureCollection',
      features: features.map((f) =>
        f?.geometry ? { ...f, geometry: decimateGeometry(f.geometry as any) as any } : f,
      ),
    }),
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
    // Per-feature color: honor properties.color (fill/point) and
    // properties.lineColor (RGBA arrays) when a caller sets them (e.g. the
    // backload views color trailers/internal/external/legs); fall back to the
    // default Snowflake blue so existing callers (directions/isochrone/POI) are
    // unchanged.
    const asRGBA = (v: unknown, fb: [number, number, number, number]): [number, number, number, number] => {
      if (Array.isArray(v) && v.length >= 3 && v.every((n) => typeof n === 'number')) {
        return [v[0], v[1], v[2], (v[3] as number) ?? 255] as [number, number, number, number];
      }
      return fb;
    };
    return [
      new GeoJsonLayer({
        id: 'inline-geojson',
        data: fc,
        filled: true,
        stroked: true,
        pickable: true,
        getFillColor: (f: GeoJSON.Feature) => asRGBA(f?.properties?.color, [41, 181, 232, 60]),
        getLineColor: (f: GeoJSON.Feature) => asRGBA(f?.properties?.lineColor ?? f?.properties?.color, [41, 181, 232, 220]),
        getLineWidth: 3,
        lineWidthMinPixels: 2,
        pointType: 'circle',
        getPointRadius: 60,
        pointRadiusMinPixels: 4,
        pointRadiusMaxPixels: 10,
        updateTriggers: {
          getFillColor: [features],
          getLineColor: [features],
        },
      }),
    ];
  }, [features, fc]);

  // Hover tooltip from a feature's properties (e.g. Overture place name/category,
  // address city/postcode). Returns null for features with no properties so
  // geometry-only results (directions / isochrones) show no tooltip.
  const getTooltip = useCallback((info: { object?: GeoJSON.Feature }) => {
    const props = info?.object?.properties as Record<string, unknown> | null | undefined;
    if (!props) return null;
    const title = props.name != null ? String(props.name) : '';
    const meta = [props.category, props.city, props.postcode]
      .filter((v) => v != null && v !== '')
      .map(String);
    const text = [title, meta.join(' \u00b7 ')].filter(Boolean).join('\n');
    return text ? { text } : null;
  }, []);

  if (features.length === 0) {
    return (
      <div style={{ padding: '12px', fontSize: '13px', color: 'var(--text-secondary, #6b7280)' }}>
        No map geometry in this result.
      </div>
    );
  }

  return (
    <div style={{ position: 'relative', width: '100%', height: 360, borderRadius: '8px', overflow: 'hidden', border: '1px solid var(--border-default, #e5e7eb)' }}>
      <MapView layers={layers} fitTo={{ coords: fitCoords, focusKey }} getTooltip={getTooltip} />
    </div>
  );
}

// Semantic alias: isochrone/catchment results render with the same component.
export const IsochroneInline = RouteMapInline;

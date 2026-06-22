'use client';
// Region boundary preview overlay for Region Builder (catalog + provisioned).
// Polygon from ST_ASGEOJSON when available; bbox rectangle fallback for
// dynamic-refreshed catalog rows with NULL BOUNDARY.

import { useCallback, useMemo, useRef } from 'react';
import { GeoJsonLayer, PathLayer } from '@deck.gl/layers';
import type { Layer } from '@deck.gl/core';
import MapView from '@/components/shared/MapView';
import RecenterButton from '@/components/shared/RecenterButton';
import { coordsFromGeoJSON, type LngLat } from '@/components/shared/mapFit';

export interface BoundaryBbox {
  minLon: number;
  minLat: number;
  maxLon: number;
  maxLat: number;
}

export interface BoundaryItem {
  key: string;
  name: string;
  geojson?: string | null;
  bbox?: BoundaryBbox | null;
  isDefault?: boolean;
}

interface Props {
  boundaries: BoundaryItem[];
  fitKey?: string;
  height?: number | string;
}

const DEFAULT_VIEW = { longitude: 0, latitude: 30, zoom: 2, pitch: 0, bearing: 0 };

/** Per-region stroke/fill RGBA; index 0 reserved for default highlight. */
const PALETTE: [number, number, number, number][] = [
  [59, 130, 246, 220],
  [16, 185, 129, 220],
  [245, 158, 11, 220],
  [168, 85, 247, 220],
  [236, 72, 153, 220],
  [20, 184, 166, 220],
];

const DEFAULT_STROKE: [number, number, number, number] = [255, 107, 53, 240];
const DEFAULT_FILL: [number, number, number, number] = [255, 107, 53, 45];

function isValidBbox(b: BoundaryBbox | null | undefined): b is BoundaryBbox {
  if (!b) return false;
  const { minLon, minLat, maxLon, maxLat } = b;
  if (![minLon, minLat, maxLon, maxLat].every(Number.isFinite)) return false;
  if (minLon === 0 && minLat === 0 && maxLon === 0 && maxLat === 0) return false;
  if (minLon >= maxLon || minLat >= maxLat) return false;
  return true;
}

function parseGeoJson(raw: string | null | undefined): GeoJSON.GeoJSON | null {
  if (!raw || typeof raw !== 'string') return null;
  try {
    const parsed = JSON.parse(raw) as GeoJSON.GeoJSON;
    if (parsed && typeof parsed === 'object' && 'type' in parsed) return parsed;
  } catch { /* ignore */ }
  return null;
}

function bboxCorners(b: BoundaryBbox): LngLat[] {
  const { minLon, minLat, maxLon, maxLat } = b;
  return [
    [minLon, minLat],
    [maxLon, minLat],
    [maxLon, maxLat],
    [minLon, maxLat],
    [minLon, minLat],
  ];
}

function strokeFill(index: number, isDefault?: boolean): { stroke: [number, number, number, number]; fill: [number, number, number, number] } {
  if (isDefault) {
    return { stroke: DEFAULT_STROKE, fill: DEFAULT_FILL };
  }
  const c = PALETTE[index % PALETTE.length];
  return { stroke: c, fill: [c[0], c[1], c[2], 50] as [number, number, number, number] };
}

export default function RegionBoundaryMap({ boundaries, fitKey, height = 260 }: Props) {
  const recenterRef = useRef<(() => void) | null>(null);

  const drawable = useMemo(
    () => boundaries.filter((b) => parseGeoJson(b.geojson) != null || isValidBbox(b.bbox)),
    [boundaries],
  );

  // Single color assignment shared by polygon layers AND legend — eliminates index drift.
  const colorByKey = useMemo(() => {
    const m = new Map<string, { stroke: [number, number, number, number]; fill: [number, number, number, number] }>();
    let colorIndex = 0;
    for (const item of drawable) {
      m.set(item.key, strokeFill(item.isDefault ? 0 : colorIndex + 1, item.isDefault));
      if (!item.isDefault) colorIndex += 1;
    }
    return m;
  }, [drawable]);

  const fitCoords = useMemo<LngLat[]>(() => {
    const out: LngLat[] = [];
    for (const item of drawable) {
      const geom = parseGeoJson(item.geojson);
      if (geom) {
        out.push(...coordsFromGeoJSON(geom));
      } else if (isValidBbox(item.bbox)) {
        out.push(...bboxCorners(item.bbox).slice(0, 4));
      }
    }
    return out.filter(
      (c) => Array.isArray(c) && c.length >= 2 && Number.isFinite(c[0]) && Number.isFinite(c[1]),
    );
  }, [drawable]);

  const layers = useMemo((): Layer[] => {
    const result: Layer[] = [];
    for (const item of drawable) {
      const colors = colorByKey.get(item.key);
      if (!colors) continue;
      const { stroke, fill } = colors;

      const geom = parseGeoJson(item.geojson);
      if (geom) {
        result.push(
          new GeoJsonLayer({
            id: `region-boundary-${item.key}`,
            data: geom,
            pickable: true,
            stroked: true,
            filled: true,
            extruded: false,
            lineWidthMinPixels: 2,
            getLineColor: stroke,
            getFillColor: fill,
            getLineWidth: 2,
          }),
        );
        continue;
      }

      if (isValidBbox(item.bbox)) {
        result.push(
          new PathLayer({
            id: `region-bbox-${item.key}`,
            data: [{ path: bboxCorners(item.bbox!) }],
            pickable: true,
            getPath: (d: { path: LngLat[] }) => d.path,
            getColor: stroke,
            getWidth: 3,
            widthMinPixels: 2,
            capRounded: true,
            jointRounded: true,
          }),
        );
      }
    }
    return result;
  }, [drawable, colorByKey]);

  const onRecenterReady = useCallback((fn: () => void) => {
    recenterRef.current = fn;
  }, []);

  if (drawable.length === 0) {
    return (
      <div
        style={{
          marginTop: '0.75rem',
          padding: '1rem',
          borderRadius: 8,
          border: '1px solid var(--border)',
          fontSize: 13,
          color: 'var(--text-secondary)',
        }}
      >
        No boundary geometry available for the selected region(s). Refresh the catalog or wait for boundary bake.
      </div>
    );
  }

  return (
    <div style={{ marginTop: '0.75rem' }}>
      <div
        style={{
          position: 'relative',
          height,
          width: '100%',
          borderRadius: 8,
          overflow: 'hidden',
          border: '1px solid var(--border)',
          background: '#e8e8e8',
        }}
      >
        <MapView
          layers={layers}
          fallbackViewState={DEFAULT_VIEW}
          fitTo={
            fitCoords.length > 0
              ? { coords: fitCoords, regionKey: fitKey, padding: 48, minZoom: 2, maxZoom: 14 }
              : undefined
          }
          onRecenterReady={onRecenterReady}
        />
        <RecenterButton
          onClick={() => recenterRef.current?.()}
          disabled={fitCoords.length === 0}
        />
      </div>
      {drawable.length > 1 && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12, marginTop: 8, fontSize: 12 }}>
          {drawable.map((b) => {
            const colors = colorByKey.get(b.key);
            const stroke = colors?.stroke ?? DEFAULT_STROKE;
            return (
              <span key={b.key} style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <span
                  style={{
                    width: 12,
                    height: 12,
                    borderRadius: 2,
                    background: `rgba(${stroke[0]},${stroke[1]},${stroke[2]},0.35)`,
                    border: `2px solid rgb(${stroke[0]},${stroke[1]},${stroke[2]})`,
                    display: 'inline-block',
                  }}
                />
                {b.name}
                {b.isDefault ? ' (default)' : ''}
              </span>
            );
          })}
        </div>
      )}
    </div>
  );
}

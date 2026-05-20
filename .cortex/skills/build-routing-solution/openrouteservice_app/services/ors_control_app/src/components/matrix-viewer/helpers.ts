// Pure helpers for MatrixViewer: number/byte/legend formatters,
// 12-stop Viridis palette, color lerp, raw-value extraction.

import { TileLayer } from '@deck.gl/geo-layers';
import { BitmapLayer } from '@deck.gl/layers';
import type { ReachabilityData } from '../../types';

export const CARTO_LIGHT = '/api/tiles/{z}/{x}/{y}';

export type GradientMetric = 'time' | 'distance';
export type ScaleMode = 'auto' | 'fixed';
export type TimeUnit = 'min' | 'hr';

export function cartoBasemap() {
  return new TileLayer({
    id: 'carto-basemap',
    data: CARTO_LIGHT,
    minZoom: 0,
    maxZoom: 19,
    tileSize: 256,
    renderSubLayers: (props: any) => {
      const { boundingBox } = props.tile;
      return new BitmapLayer(props, {
        data: undefined,
        image: props.data,
        bounds: [boundingBox[0][0], boundingBox[0][1], boundingBox[1][0], boundingBox[1][1]],
      });
    },
  });
}

export function formatNumber(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M';
  if (n >= 1_000) return (n / 1_000).toFixed(1) + 'K';
  return n.toLocaleString();
}

export function formatBytes(bytes: number): string {
  if (bytes >= 1_000_000_000) return (bytes / 1_000_000_000).toFixed(1) + ' GB';
  if (bytes >= 1_000_000) return (bytes / 1_000_000).toFixed(1) + ' MB';
  if (bytes >= 1_000) return (bytes / 1_000).toFixed(1) + ' KB';
  return bytes + ' B';
}

// 12-stop Viridis palette (sampled from matplotlib reference).
// Perceptually uniform, monotonic luminance, colorblind-friendly.
export const COLORS: [number, number, number][] = [
  [68, 1, 84],
  [72, 35, 116],
  [64, 67, 135],
  [52, 94, 141],
  [41, 120, 142],
  [32, 144, 140],
  [34, 167, 132],
  [68, 190, 112],
  [121, 209, 81],
  [189, 222, 38],
  [253, 231, 36],
  [253, 231, 60],
];

export function rgb(c: [number, number, number]): string {
  return `rgb(${c[0]},${c[1]},${c[2]})`;
}

export function lerpColor(stops: [number, number, number][], t: number): [number, number, number] {
  const clamped = Math.max(0, Math.min(1, t));
  const scaled = clamped * (stops.length - 1);
  const i = Math.floor(scaled);
  const f = scaled - i;
  if (i >= stops.length - 1) return stops[stops.length - 1];
  const a = stops[i];
  const b = stops[i + 1];
  return [
    Math.round(a[0] + (b[0] - a[0]) * f),
    Math.round(a[1] + (b[1] - a[1]) * f),
    Math.round(a[2] + (b[2] - a[2]) * f),
  ];
}

const KM_PER_M = 1 / 1000;

export function rawValue(d: ReachabilityData, metric: GradientMetric, timeUnit: TimeUnit): number {
  if (metric === 'time') {
    return timeUnit === 'min' ? d.travel_time_secs / 60 : d.travel_time_secs / 3600;
  }
  return d.distance_meters * KM_PER_M;
}

export function unitSuffix(metric: GradientMetric, timeUnit: TimeUnit): string {
  if (metric === 'time') return timeUnit === 'min' ? 'min' : 'hr';
  return 'km';
}

export function fmtLegend(val: number): string {
  if (val >= 100) return Math.round(val).toString();
  if (val >= 10) return val.toFixed(0);
  if (val >= 1) return val.toFixed(1);
  return val.toFixed(2);
}

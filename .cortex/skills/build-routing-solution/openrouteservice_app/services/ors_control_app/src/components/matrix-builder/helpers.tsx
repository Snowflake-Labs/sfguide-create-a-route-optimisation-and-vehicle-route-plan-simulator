// Pure helpers for MatrixBuilder: hex/pair estimators, duration/byte/time
// formatters, stage-index lookup, RoadFilterBadge.

import type { RegionInfo } from '../../types';
import { RES_HEX_PER_SQDEG, RES_HEX_AREA_KM2 } from '../../types';

export const RATE_PAIRS_PER_SEC = 31500;
export const CREDIT_PER_HOUR_SMALL = 2;
export const ALL_RESOLUTIONS = [5, 6, 7, 8, 9, 10];

// Polygon-aware fast estimator. Prefers REGION_CATALOG.BOUNDARY_AREA_KM2
// (set by the server in /api/matrix/regions) so the pre-server-response
// preview matches what BUILD_HEXAGONS will actually produce. Falls back to
// the bbox rectangle area when no catalog row matched.
export function estimateHexCount(region: RegionInfo, res: number): number {
  const hexAreaKm2 = RES_HEX_AREA_KM2[res] ?? 1;
  if (region.boundaryAreaKm2 != null && region.boundaryAreaKm2 > 0) {
    return Math.ceil(region.boundaryAreaKm2 / hexAreaKm2);
  }
  const b = region.bounds;
  const latSpanKm = (b.maxLat - b.minLat) * 111;
  const midLat = (b.maxLat + b.minLat) / 2;
  const lonSpanKm = (b.maxLon - b.minLon) * 111 * Math.cos((midLat * Math.PI) / 180);
  const bboxAreaKm2 = Math.max(0, latSpanKm * lonSpanKm);
  if (bboxAreaKm2 > 0) {
    return Math.ceil(bboxAreaKm2 / hexAreaKm2);
  }
  // Last-ditch legacy degree-area heuristic
  const areaDeg2 = (b.maxLat - b.minLat) * (b.maxLon - b.minLon);
  return Math.round(areaDeg2 * (RES_HEX_PER_SQDEG[res] || 2000));
}

export function estimatePairs(hexCount: number): number {
  return hexCount * (hexCount - 1);
}

export function formatNumber(n: number): string {
  if (n >= 1_000_000_000) return (n / 1_000_000_000).toFixed(1) + 'B';
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M';
  if (n >= 1_000) return (n / 1_000).toFixed(1) + 'K';
  return n.toLocaleString();
}

export function formatDuration(minutes: number): string {
  if (minutes < 1) return `${Math.round(minutes * 60)}s`;
  if (minutes < 60) return `${Math.round(minutes)} min`;
  const hrs = Math.floor(minutes / 60);
  const mins = Math.round(minutes % 60);
  return mins > 0 ? `${hrs}h ${mins}m` : `${hrs}h`;
}

export function formatBytes(bytes: number): string {
  if (bytes >= 1_000_000_000) return (bytes / 1_000_000_000).toFixed(1) + ' GB';
  if (bytes >= 1_000_000) return (bytes / 1_000_000).toFixed(1) + ' MB';
  if (bytes >= 1_000) return (bytes / 1_000).toFixed(1) + ' KB';
  return bytes + ' B';
}

export function timeAgo(dateStr: string): string {
  if (!dateStr) return '';
  const d = new Date(dateStr);
  const now = new Date();
  const secs = Math.floor((now.getTime() - d.getTime()) / 1000);
  if (secs < 60) return 'just now';
  if (secs < 3600) return `${Math.floor(secs / 60)}m ago`;
  if (secs < 86400) return `${Math.floor(secs / 3600)}h ago`;
  return `${Math.floor(secs / 86400)}d ago`;
}

export const STAGE_STEPS = [
  { key: 'HEXAGONS', label: 'Hexagons', icon: '⬡' },
  { key: 'WORK_QUEUE', label: 'Work Queue', icon: '📋' },
  { key: 'BUILDING', label: 'API Calls', icon: '⟳' },
  { key: 'FLATTENING', label: 'Flatten', icon: '⚡' },
  { key: 'COMPLETE', label: 'Complete', icon: '✓' },
];

export function getStageIndex(stage: string): number {
  if (stage === 'NOT_STARTED' || stage === 'STARTING' || stage === 'PENDING') return -1;
  const idx = STAGE_STEPS.findIndex((s) => s.key === stage);
  return idx >= 0 ? idx : -1;
}

export function RoadFilterBadge({ on }: { on: boolean | undefined }) {
  if (!on) return null;
  return (
    <span
      title="Built with Road-Aware Filtering: only hexagons intersecting road segments were tessellated"
      style={{
        display: 'inline-block',
        marginLeft: 6,
        padding: '1px 6px',
        fontSize: 10,
        fontWeight: 600,
        letterSpacing: 0.3,
        textTransform: 'uppercase',
        color: '#3fb950',
        background: 'rgba(63, 185, 80, 0.12)',
        border: '1px solid rgba(63, 185, 80, 0.4)',
        borderRadius: 4,
        verticalAlign: 'middle',
      }}
    >
      road-aware
    </span>
  );
}

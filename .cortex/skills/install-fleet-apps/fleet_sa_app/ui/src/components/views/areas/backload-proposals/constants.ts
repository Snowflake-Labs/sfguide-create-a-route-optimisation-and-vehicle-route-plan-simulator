// Shared palette, style helpers, and small constants for the Backload
// Proposals dispatcher cockpit. Neutral / industry-agnostic - no vendor
// branding. Uses the app CSS variables so the cockpit themes with the rest of
// the SA app.

import type { CSSProperties } from 'react';
import type { StrategyFamily } from '../backload-ensemble';

// deck.gl marker colours (RGB), aligned to the Backload Matching map so the two
// dashboards read identically: idle vehicle = green (white ring), internal load
// = Snowflake blue, external offer = grey (grey ring).
export const COLOR_VEHICLE: [number, number, number] = [22, 163, 74];
export const COLOR_INTERNAL: [number, number, number] = [41, 181, 232];
export const COLOR_EXTERNAL: [number, number, number] = [200, 200, 200];
// Marker strokes (match Matching: white ring on vehicles, grey ring on external).
export const COLOR_VEHICLE_STROKE: [number, number, number] = [255, 255, 255];
export const COLOR_EXTERNAL_STROKE: [number, number, number] = [120, 120, 120];

// Per-leg route colours for the selected proposal on the map:
//   empty -> pickup    = dashed grey (repositioning, no revenue)
//   pickup -> delivery = green (loaded, revenue leg)
//   delivery -> next    = blue  (onward to the vehicle's next start)
export const COLOR_LEG_EMPTY: [number, number, number] = [110, 110, 110];
export const COLOR_LEG_LOADED: [number, number, number] = [22, 127, 55];
export const COLOR_LEG_NEXT: [number, number, number] = [37, 99, 235];

// Selected-row / selected-card accent (Snowflake green).
export const SELECT_RING = '#0DB048';
export const SELECT_BG = 'rgba(13,176,72,0.06)';

// Card / panel surface used by the master lists + drawer.
export const panelStyle: CSSProperties = {
  border: '1px solid var(--border)',
  borderRadius: 8,
  background: 'var(--surface)',
};

// status-badge variant per optimizer family: the winning family keeps its
// colour; others render neutral in the ensemble sub-rows.
export const FAMILY_BADGE: Record<StrategyFamily, string> = {
  baseline: 'info',
  vrp: 'caution',
  fleet: 'neutral',
  bpmp: 'success',
};

// Reason codes offered when a dispatcher rejects a proposal (session-only).
export const REJECT_REASONS = [
  'Too far',
  'Wrong equipment',
  'Customer relationship',
  'Already assigned',
  'Bad timing',
  'Other',
];

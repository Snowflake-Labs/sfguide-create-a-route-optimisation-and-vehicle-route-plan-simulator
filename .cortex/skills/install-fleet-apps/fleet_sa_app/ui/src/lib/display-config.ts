// Display-config resolver: the consumption layer for the zero-code retargeting
// surface (app-config.json "display" block, typed as DisplayConfig). It lets
// app-views.json reference neutral tokens ({{labels.entity}}, {{units.distance}})
// and metric cards color by named thresholds, so a domain swap is a config edit.
//
// Two access paths:
//   - useDisplayConfig()      React hook (reads the zustand store) for components.
//   - getDisplayConfigGlobal() module mirror for non-React code (view registration
//     in load-views.tsx runs before/outside React render).
// Token interpolation is a no-op when a string contains no "{{" or no config is
// loaded, so every existing hardcoded label is unaffected (back-compat).

import { useAppStore } from './store';
import type { DisplayConfig, DisplayThreshold } from './types';

// Module-level mirror, set alongside the store in app-shell so view registration
// (which is not a React render) can interpolate labels/descriptions.
let globalDisplayConfig: DisplayConfig | null = null;

export function setDisplayConfigGlobal(cfg: DisplayConfig | null | undefined): void {
  globalDisplayConfig = cfg ?? null;
}

export function getDisplayConfigGlobal(): DisplayConfig | null {
  return globalDisplayConfig;
}

// {{group.key}} where group is a string-map section of DisplayConfig (labels/units).
const TOKEN_RE = /\{\{\s*([a-zA-Z0-9_]+)\.([a-zA-Z0-9_]+)\s*\}\}/g;

// Replace {{labels.x}} / {{units.x}} tokens. Unknown tokens are left verbatim.
export function interpolateTokens(text: string, cfg: DisplayConfig | null): string {
  if (!cfg || typeof text !== 'string' || text.indexOf('{{') === -1) return text;
  return text.replace(TOKEN_RE, (full, group: string, key: string) => {
    const bag = (cfg as unknown as Record<string, unknown>)[group];
    if (bag && typeof bag === 'object') {
      const v = (bag as Record<string, unknown>)[key];
      if (typeof v === 'string') return v;
    }
    return full;
  });
}

const COLOR_GOOD = '#16a34a';
const COLOR_WARN = '#d97706';
const COLOR_CRIT = '#dc2626';

// Threshold-band color for a metric value. Returns undefined when no threshold is
// defined for the metric (caller keeps the default color). Honors higherIsBetter.
export function thresholdColor(
  cfg: DisplayConfig | null,
  metric: string | undefined,
  value: number,
): string | undefined {
  if (!cfg?.thresholds || !metric || isNaN(value)) return undefined;
  const t: DisplayThreshold | undefined = cfg.thresholds[metric];
  if (!t) return undefined;
  const higherIsBetter = t.higherIsBetter !== false; // default: higher is better
  if (higherIsBetter) {
    if (t.good != null && value >= t.good) return COLOR_GOOD;
    if (t.critical != null && value <= t.critical) return COLOR_CRIT;
    if (t.warn != null && value < t.warn) return COLOR_WARN;
    return undefined;
  }
  // lower is better (dwell, eta_variance, idle)
  if (t.good != null && value <= t.good) return COLOR_GOOD;
  if (t.critical != null && value >= t.critical) return COLOR_CRIT;
  if (t.warn != null && value > t.warn) return COLOR_WARN;
  return undefined;
}

// Look up a unit suffix string (e.g. "km/h") by units-token key.
export function unitSuffix(cfg: DisplayConfig | null, unitKey: string | undefined): string {
  if (!cfg?.units || !unitKey) return '';
  return cfg.units[unitKey] ?? '';
}

// React hook: the display config from the store (null until app-config loads).
export function useDisplayConfig(): DisplayConfig | null {
  return useAppStore((s) => s.displayConfig);
}

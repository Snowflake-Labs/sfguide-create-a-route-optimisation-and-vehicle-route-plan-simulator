// Admin-wide numeric helpers. The decimal policy itself lives in lib/format-number
// (shared with the SA app) so the two apps cannot disagree about how many decimals
// a user is shown; this module only keeps the admin's own call signature.

import { formatNumber, MAX_DECIMALS } from '@/lib/format-number';

/**
 * Fixed-decimal helper used across the admin pages.
 *
 * `decimals` is capped at the shared MAX_DECIMALS: callers ask for 1dp today, and
 * a future caller asking for 6 would reintroduce exactly the noise this cap
 * exists to remove. Coordinates must not go through here - use formatNumber with
 * the column name, which applies the coordinate exemption.
 */
export function fmtDec(v: unknown, decimals = 1): string {
  const n = Number(v);
  if (v == null || v === '' || isNaN(n)) return '-';
  return n.toFixed(Math.min(decimals, MAX_DECIMALS));
}

/** Re-exported so admin pages have one obvious import for the general case. */
export { formatNumber };

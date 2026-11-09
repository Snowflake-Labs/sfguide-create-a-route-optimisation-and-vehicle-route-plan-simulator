// Input sanitization helpers used by every server route. Pure functions, no
// dependencies on Snowflake / Express / module-level state.

import { readFileSync } from 'fs';
import { ROUTING_PROFILES } from '@/lib/types';

type RoutingProfile = (typeof ROUTING_PROFILES)[number];

const IDENTIFIER_RE = /^[A-Za-z][A-Za-z0-9_]{0,254}$/;

export function sanitizeIdentifier(val: string): string {
  const cleaned = val.replace(/[^A-Za-z0-9_]/g, '');
  if (!IDENTIFIER_RE.test(cleaned)) throw new Error(`Invalid identifier: ${val}`);
  return cleaned;
}

export function sanitizeFloat(val: any): number {
  const n = Number(val);
  if (!Number.isFinite(n)) throw new Error(`Invalid number: ${val}`);
  return n;
}

export function sanitizeInt(val: any): number {
  const n = Math.round(Number(val));
  if (!Number.isFinite(n) || n < 0 || n > 10000) throw new Error(`Invalid integer: ${val}`);
  return n;
}

export function escapeString(val: string): string {
  return val.replace(/\\/g, '\\\\').replace(/'/g, "''").replace(/[\x00-\x1f]/g, '');
}

// Routing profile and H3 resolution reach SQL as parts of TRAVEL_MATRIX table
// NAMES (`<REGION>_<PROFILE>_MATRIX_RES<n>`), i.e. unquoted identifiers, where
// escapeString protects nothing. They are therefore validated against fixed
// allowlists, never cleaned: `runSql` has no bind parameters to fall back on.

/** Allowlisted ORS profile plus its identifier form (DRIVING_CAR). Throws otherwise. */
export function sanitizeProfile(val: unknown): { profile: RoutingProfile; upper: string } {
  if (typeof val !== 'string' || !(ROUTING_PROFILES as readonly string[]).includes(val)) {
    throw new Error(`Invalid profile: ${String(val)}`);
  }
  const profile = val as RoutingProfile;
  return { profile, upper: profile.replace(/-/g, '_').toUpperCase() };
}

const MIN_RES = 5;
const MAX_RES = 10;

/** Non-empty, de-duplicated list of integer H3 resolutions 5..10. Throws otherwise. */
export function sanitizeResolutions(val: unknown): number[] {
  if (!Array.isArray(val) || val.length === 0) throw new Error('resolutions must be a non-empty array');
  const out = new Set<number>();
  for (const r of val) {
    if (typeof r !== 'number' || !Number.isInteger(r) || r < MIN_RES || r > MAX_RES) {
      throw new Error(`resolutions must be integers ${MIN_RES}-${MAX_RES} (got ${String(r)})`);
    }
    out.add(r);
  }
  return Array.from(out);
}

/** One resolution from a URL or a stored row: `RES7` or `7` -> canonical `RES7`. Throws otherwise. */
export function sanitizeResolution(val: unknown): string {
  const m = /^(?:RES)?(\d{1,2})$/i.exec(String(val ?? ''));
  const n = m ? Number(m[1]) : NaN;
  if (!Number.isInteger(n) || n < MIN_RES || n > MAX_RES) throw new Error(`Invalid resolution: ${String(val)}`);
  return `RES${n}`;
}

export function getSpcsToken(): string {
  return readFileSync('/snowflake/session/token', 'utf-8').trim();
}

// Normalise Snowflake-returned timestamps to ISO 8601 strings so JS Date()
// can parse them in the browser. Used by every endpoint that returns a
// timestamp column. Without this transform, raw Snowflake values such as
// '2026-05-11 06:52:13.367' (no timezone) cause `new Date(s)` to return
// 'Invalid Date' in some browsers/locales.
export function toIso(v: any): any {
  if (v == null) return v;
  if (v instanceof Date) return isNaN(v.getTime()) ? null : v.toISOString();
  if (typeof v === 'object' && typeof (v as any).toISOString === 'function') {
    try { return (v as any).toISOString(); } catch { return null; }
  }
  if (typeof v === 'number' && Number.isFinite(v)) {
    return new Date(v > 1e12 ? v : v * 1000).toISOString();
  }
  if (typeof v === 'string') {
    const s = v.trim();
    if (/^-?\d+(\.\d+)?$/.test(s)) {
      const n = Number(s);
      if (Number.isFinite(n)) return new Date(n * 1000).toISOString();
    }
    const m = s.match(/^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2}:\d{2}(?:\.\d+)?)(Z|[+-]\d{2}:?\d{2})?$/);
    if (m) {
      const tz = m[3] || 'Z';
      const d = new Date(`${m[1]}T${m[2]}${tz}`);
      return isNaN(d.getTime()) ? s : d.toISOString();
    }
    const d = new Date(s);
    return isNaN(d.getTime()) ? s : d.toISOString();
  }
  return v;
}

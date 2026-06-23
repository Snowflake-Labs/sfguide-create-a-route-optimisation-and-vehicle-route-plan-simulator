// Input sanitization helpers used by every server route. Pure functions, no
// dependencies on Snowflake / Express / module-level state.

import { readFileSync } from 'fs';

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

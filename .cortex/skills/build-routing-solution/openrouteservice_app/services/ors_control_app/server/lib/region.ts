// Server-side region resolution helpers.
//
// Mirrors the gateway's `_normalize_region` / `resolve_ors_host` /
// `resolve_vroom_host` pattern from
// services/gateway/routing_service.py: every region (including the default)
// flows through the same path. Empty / "default" / missing input resolves to
// DEFAULT_REGION_NAME so callers never need their own fallback branch.
//
// Public API:
//   - DEFAULT_REGION_NAME              canonical default region (matches gateway env)
//   - normalizeRegion(input)           lenient: strips bad chars, falls back to default, never throws
//   - safeRegionIdent(input)           strict: throws on invalid identifier after fallback resolution
//   - orsServiceName(region)           per-region SPCS service identifier
//   - currentRegionScalar(schema)      SQL fragment "(SELECT REGION FROM ...CONFIG LIMIT 1)"

import { SF_DATABASE } from '../constants.js';

export const DEFAULT_REGION_NAME = process.env.DEFAULT_REGION_NAME || 'SanFrancisco';

const IDENTIFIER_RE = /^[A-Za-z][A-Za-z0-9_]{0,254}$/;

// Best-effort canonical region name. Strips characters that would be unsafe
// in identifiers; returns DEFAULT_REGION_NAME for empty input or the legacy
// "default" sentinel. Never throws — use for log lines, cache keys, and
// branches that just need *some* region to key off.
export function normalizeRegion(input: string | null | undefined): string {
  const raw = String(input ?? '').replace(/[^A-Za-z0-9_]/g, '');
  if (!raw || raw.toUpperCase() === 'DEFAULT') return DEFAULT_REGION_NAME;
  return raw;
}

// Strict region identifier for use in SQL. Resolves the default-region
// fallback first, then validates against IDENTIFIER_RE. Throws if the input
// (after normalization) is not a valid Snowflake identifier.
export function safeRegionIdent(input: string | null | undefined): string {
  const normalized = normalizeRegion(input);
  if (!IDENTIFIER_RE.test(normalized)) {
    throw new Error(`Invalid region identifier: ${input}`);
  }
  return normalized;
}

// Returns true when the supplied input would resolve to the default region.
// Use for "is this the legacy bare ORS_SERVICE call?" branches.
export function isDefaultRegion(input: string | null | undefined): boolean {
  const raw = String(input ?? '').trim();
  if (!raw || raw.toUpperCase() === 'DEFAULT') return true;
  return normalizeRegion(raw).toUpperCase() === DEFAULT_REGION_NAME.toUpperCase();
}

// SPCS service name for a region's ORS service.
// Mirrors the per-region naming that the gateway resolves at runtime
// (resolve_ors_host -> "ors-service-<region_lower>").
export function orsServiceName(region: string | null | undefined): string {
  return `ORS_SERVICE_${safeRegionIdent(region).toUpperCase()}`;
}

// Fully qualified SPCS service name including database + schema.
export function orsServiceFqn(region: string | null | undefined): string {
  return `${SF_DATABASE}.CORE.${orsServiceName(region)}`;
}

// SQL fragment that pulls the currently-active region from a per-demo CONFIG
// table. Single source of truth for the otherwise duplicated subquery
// "(SELECT REGION FROM FLEET_INTELLIGENCE.<schema>.CONFIG LIMIT 1)".
export function currentRegionScalar(
  schema: 'BACKLOAD_MATCHING' | 'ROUTE_OPTIMIZATION',
): string {
  return `(SELECT REGION FROM FLEET_INTELLIGENCE.${schema}.CONFIG LIMIT 1)`;
}

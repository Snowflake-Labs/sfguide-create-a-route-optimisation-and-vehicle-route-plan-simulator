// Shared region-scoped sourcing helpers for the universal-generation engines
// (anchors, hazard, demographics, demand). Centralises the cost-safe Overture /
// Marketplace query pattern so every generator filters identically:
//   1. cheap bbox prune (uses the spatial index / micro-partition pruning)
//   2. authoritative ST_INTERSECTS against the region BOUNDARY polygon
//      (NULL-safe: when no boundary row exists the bbox alone is used)
//
// The boundary is resolved against OPENROUTESERVICE_APP.CORE.REGION_CATALOG via
// the canonical regionCatalogMatch ranking (same as engine/routability.ts), so
// a deployed region always resolves to its unique REGION_KEY row.

import type { GenerationConfig } from '../profiles';
import { regionCatalogMatch } from '../../lib/region-catalog-match';
import brandTerms from './brand-terms.json';

/** Escape a string for embedding in a single-quoted SQL literal. */
export function sqlLit(s: string): string {
  return `'${String(s).replace(/'/g, "''")}'`;
}

export interface RegionBbox {
  min_lat: number;
  max_lat: number;
  min_lng: number;
  max_lng: number;
}

/**
 * A `region_boundary` CTE that yields one row with a `BOUNDARY` GEOGRAPHY column
 * for the active region (or zero rows when the region has no catalog polygon).
 * Intended to be the first CTE of a generator query and LEFT JOINed (`ON TRUE`)
 * so the bbox filter still applies when BOUNDARY is absent.
 */
export function regionBoundaryCte(region: string): string {
  const m = regionCatalogMatch('rc', sqlLit(region));
  return `region_boundary AS (
      SELECT BOUNDARY
      FROM OPENROUTESERVICE_APP.CORE.REGION_CATALOG rc
      WHERE rc.BOUNDARY IS NOT NULL
        AND ${m.predicate}
      ORDER BY ${m.rank}
      LIMIT 1
    )`;
}

/**
 * Cost-safe spatial WHERE fragment: bbox prune + NULL-safe boundary refine.
 * @param geomExpr GEOGRAPHY expression for the candidate row (e.g. `p.GEOMETRY`).
 * @param bbox     region bounding box (lat/lng).
 * @param boundaryAlias alias of the region_boundary CTE join (default `rb`).
 */
export function spatialFilter(geomExpr: string, bbox: RegionBbox, boundaryAlias = 'rb'): string {
  return `ST_Y(${geomExpr}) BETWEEN ${bbox.min_lat} AND ${bbox.max_lat}
      AND ST_X(${geomExpr}) BETWEEN ${bbox.min_lng} AND ${bbox.max_lng}
      AND COALESCE(ST_INTERSECTS(${geomExpr}, ${boundaryAlias}.BOUNDARY), TRUE)`;
}

/** Convenience: pull region + bbox off the GenerationConfig. */
export function regionFrom(config: GenerationConfig): { region: string; bbox: RegionBbox } {
  return { region: config.region, bbox: config.bbox };
}

/**
 * SQL predicate that excludes Overture places whose name carries a brand this
 * solution must stay neutral about.
 *
 * Why this exists: POI names come from a third-party map dataset, so they are
 * real business names, and a few of them are the very brands the demo must not
 * appear built for. On a live dataset three generated offers rendered a pickup or
 * dropoff label naming the customer, which makes a neutral demo look
 * customer-specific even though nothing in the code named a customer.
 *
 * The term list lives in brand-terms.json, which is also what the pre-commit
 * brand gate reads. Holding it in one place is not tidiness: duplicating the
 * strings into TypeScript made the gate flag its own filter.
 *
 * Applied at POI SELECTION so a brand name never enters DIM_POIS, and therefore
 * never reaches a trip, an offer, a listing text, a map tooltip or an agent
 * answer.
 */
export const BRAND_EXCLUDED_NAMES: string[] = brandTerms.poi_exclude;

export function brandNeutralNameFilter(nameExpr: string): string {
  const terms = BRAND_EXCLUDED_NAMES.map((t) => `'%${t}%'`).join(', ');
  // Must be NOT (x ILIKE ANY (...)). Snowflake rejects `NOT ILIKE ANY` outright
  // with a syntax error, so the negation has to wrap the whole predicate.
  // COALESCE keeps unnamed places: a NULL name is not a brand.
  return `NOT (COALESCE(${nameExpr}, '') ILIKE ANY (${terms}))`;
}

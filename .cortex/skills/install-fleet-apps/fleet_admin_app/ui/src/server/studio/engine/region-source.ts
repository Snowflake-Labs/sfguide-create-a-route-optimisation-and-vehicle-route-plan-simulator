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

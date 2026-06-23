// Single source of truth for resolving a region to ONE OPENROUTESERVICE_APP.CORE.REGION_CATALOG row.
//
// Why this exists
// ---------------
// REGION_CATALOG holds many rows that share the same human name. The natural-earth
// admin-1 layer emits a bare LOOKUP_NAME (e.g. the state "México" -> LOOKUP_NAME='Mexico')
// that collides with the geofabrik country row (LOOKUP_NAME='Mexico'), with bbbike
// cities, and with same-name sub-regions in other countries. ~470 catalog rows
// participate in such LOOKUP_NAME collisions.
//
// The old resolution heuristic ("ORDER BY BOUNDARY_AREA_KM2 ASC LIMIT 1" — pick the
// smallest polygon with this name) silently returned the WRONG polygon for any
// deployed region whose name collided with a smaller same-name sub-region. Concretely,
// deploying the country "Mexico" rendered only the small "Estado de México" polygon.
//
// The fix
// -------
// A deployed region is always identified by its UNIQUE REGION_CATALOG.REGION_KEY
// (REGION_ORS_MAP.REGION and REGION_REGISTRY.ORS_REGION_KEY both equal the chosen
// row's REGION_KEY; natural-earth disambiguates duplicate keys with an ISO suffix
// e.g. 'MexicoMX', geofabrik keys embed the hierarchy path). Therefore the correct,
// deterministic resolution is:
//   1. exact REGION_KEY match   (unique -> authoritative for every deployed region)
//   2. exact LOOKUP_NAME match
//   3. exact REGION_NAME match
//   then, within the same tier (only relevant for ambiguous free-text input, never
//   for deployed regions which already match uniquely at tier 0):
//   4. broader administrative LEVEL first (continent > country > sub-region > ...)
//   5. larger BOUNDARY_AREA_KM2 first
//
// Usage
// -----
// `target` is the SQL right-hand side to compare against — either a quoted, escaped
// literal (e.g. `"'" + escapeString(region) + "'"`) or a column reference
// (e.g. `'rr.ORS_REGION_KEY'`). The caller owns quoting/escaping of literals.
//
//   const M = regionCatalogMatch('rc', `'${escapeString(region)}'`);
//   `... LEFT JOIN REGION_CATALOG rc ON rc.BOUNDARY IS NOT NULL AND ${M.predicate}
//        QUALIFY ROW_NUMBER() OVER (PARTITION BY x ORDER BY ${M.rank}) = 1`
//
// or for an `ORDER BY ... LIMIT 1` style query:
//   `... WHERE ${M.predicate} ORDER BY ${M.rank} LIMIT 1`

export interface RegionCatalogMatch {
  /** Boolean predicate that is TRUE for any catalog row matching `target`. */
  predicate: string;
  /** Comma-separated ORDER BY expression that ranks the best (correct) row first. */
  rank: string;
}

const LEVEL_RANK =
  "CASE %A%LEVEL WHEN 'continent' THEN 0 WHEN 'country' THEN 1 " +
  "WHEN 'sub-region' THEN 2 WHEN 'sub-sub-region' THEN 3 ELSE 4 END";

/**
 * Build the canonical match predicate + ranking for resolving a region against
 * REGION_CATALOG. See module header for the full rationale.
 *
 * @param alias  Table alias used in the query (e.g. 'rc'). Pass '' for no alias.
 * @param target SQL expression to match against — a quoted+escaped literal
 *               (`"'Mexico'"`) or a column reference (`'rr.ORS_REGION_KEY'`).
 */
export function regionCatalogMatch(alias: string, target: string): RegionCatalogMatch {
  const a = alias ? `${alias}.` : '';
  const predicate =
    `(UPPER(${a}REGION_KEY) = UPPER(${target}) ` +
    `OR UPPER(${a}LOOKUP_NAME) = UPPER(${target}) ` +
    `OR UPPER(${a}REGION_NAME) = UPPER(${target}))`;
  const rank = [
    `CASE WHEN UPPER(${a}REGION_KEY) = UPPER(${target}) THEN 0 ` +
      `WHEN UPPER(${a}LOOKUP_NAME) = UPPER(${target}) THEN 1 ELSE 2 END`,
    LEVEL_RANK.replace(/%A%/g, a),
    `COALESCE(${a}BOUNDARY_AREA_KM2, 0) DESC`,
  ].join(', ');
  return { predicate, rank };
}

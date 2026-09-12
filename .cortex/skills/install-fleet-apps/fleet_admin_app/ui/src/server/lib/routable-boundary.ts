// Land-clipped region boundaries: which column to read, and how a region that
// predates the clip heals itself.
//
// Why this exists
// ---------------
// REGION_CATALOG.BOUNDARY is the Geofabrik/BBBike PBF EXTRACT polygon - a
// download cut line, not a land outline. Coastal cuts run well out to sea so the
// extract fully contains the coastline. MEASURED for the US: BOUNDARY is
// 31,357,889 km2 against 10,146,511 km2 of land, so roughly two thirds of every
// "inside the region" point is open Pacific, and ORS answers with
//
//   code 2010 - Could not find routable point within a radius of 1000.0 meters
//
// ROUTABLE_BOUNDARY (BOUNDARY intersected with the Overture division-area union)
// is the land mask, baked and cached by CORE.ENSURE_ROUTABLE_BOUNDARY.
//
// Which column to use
// -------------------
// Two selectors, chosen by cost per use, not by taste.
//
// ROUTABLE_BOUNDARY_EXACT - the authoritative clip. Correct but heavy: the US
// clip is 68,987 vertices. Use it for low-cardinality tests, e.g. rejection
// sampling a few thousand candidate points once per region.
//
// ROUTABLE_BOUNDARY_FAST - the same mask decimated with a size-scaled tolerance,
// 3,510 vertices and 165 KB of GeoJSON for the US against 3.24 MB exact, losing
// 0.04% of the area and still rejecting the same open-ocean coordinates. Use it
// for anything paid PER ROW and for anything crossing the network. MEASURED on
// one H3 res-4 cell of Overture segments: 2.7 s with the exact mask against 1.2 s
// with this one, on a query that runs on every reshuffle.
//
// Every selector COALESCEs back to BOUNDARY. A region without the Overture share,
// or one whose clip was rejected as implausible, keeps working exactly as it did
// before this change rather than losing its polygon entirely.

import { runSql } from '@/server/lib/sql';
import { SF_DATABASE } from '@/server/constants';
import { regionCatalogMatch } from '@/server/lib/region-catalog-match';
import { escapeString } from '@/server/lib/sanitize';
import { log } from '@/server/diagnostics';

/** Authoritative mask. Heavy - only for low-cardinality geometry tests. */
export const ROUTABLE_BOUNDARY_EXACT = 'COALESCE(ROUTABLE_BOUNDARY, BOUNDARY)';

/** Decimated mask. For per-row filtering and for anything sent to a browser. */
export const ROUTABLE_BOUNDARY_FAST =
  'COALESCE(ROUTABLE_BOUNDARY_SIMPLE, ROUTABLE_BOUNDARY, BOUNDARY)';

/**
 * SQL expression reporting which mask a row will actually serve, so the UI can
 * say whether points are being drawn from land or from the raw extract.
 */
export const ROUTABLE_BOUNDARY_SOURCE_EXPR =
  "IFF(ROUTABLE_BOUNDARY IS NOT NULL, 'routable', 'extract')";

// One bake attempt per region per process. The clip is an intersection against
// the global Overture divisions table, so it must never be awaited inside a
// request and must never be queued repeatedly by a user clicking Reshuffle.
const bakeAttempted = new Set<string>();

/**
 * Fire-and-forget bake for a region provisioned before the clip existed, or one
 * that reached READY without passing through PROVISION_REGION_WRAPPER.
 *
 * Deliberately NOT awaited: the caller serves this request from the unclipped
 * BOUNDARY and the next reshuffle picks up the baked mask. Awaiting it would put
 * a continental ST_INTERSECTION on the Function Tester's latency path, which is
 * the opposite of the point.
 *
 * New installs never reach this - PROVISION_REGION_WRAPPER bakes on the success
 * path. This is purely the self-heal for existing deployments.
 */
export function ensureRoutableBoundaryAsync(region: string): void {
  if (!region || region === 'default') return;
  const key = region.toUpperCase();
  if (bakeAttempted.has(key)) return;
  bakeAttempted.add(key);
  void (async () => {
    try {
      await runSql(
        `CALL ${SF_DATABASE}.CORE.ENSURE_ROUTABLE_BOUNDARY('${escapeString(region)}')`,
      );
      log('INFO', 'RoutableBoundary', `Baked land clip for ${region}`);
    } catch (e) {
      // Overture share missing, insufficient privileges, geometry error. The
      // region keeps its extract polygon; do not retry this process.
      log('WARN', 'RoutableBoundary', `Bake failed for ${region}: ${(e as Error)?.message}`);
    }
  })();
}

/**
 * Resolve whether a region already has a land mask. Single catalog row, so this
 * is cheap enough to sit in a request path.
 */
export async function getBoundarySource(region: string): Promise<'routable' | 'extract' | null> {
  const m = regionCatalogMatch('', `'${escapeString(region)}'`);
  try {
    const rows = await runSql(
      `SELECT ${ROUTABLE_BOUNDARY_SOURCE_EXPR} AS SRC
       FROM ${SF_DATABASE}.CORE.REGION_CATALOG
       WHERE ${m.predicate} AND BOUNDARY IS NOT NULL
       ORDER BY ${m.rank} LIMIT 1`,
    );
    const src = rows?.[0]?.SRC;
    return src === 'routable' || src === 'extract' ? src : null;
  } catch {
    return null;
  }
}

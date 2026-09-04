// POI loading + routability filtering. Loads candidate POIs from Overture
// Maps clipped to the region polygon, then prunes to POIs that ORS can
// actually snap to a road on the active graph (eliminates border-bbox leakage).

import type { POI, SnowSqlFn } from './types';
import { GenerationConfig, uuid } from '../profiles';
import { log } from '../../diagnostics';
import { regionCatalogMatch } from '../../lib/region-catalog-match';
import { h3ResForArea, poiCapForArea } from './spatial';

// Look up ISO-2 country codes for the active region from FLEET_INTELLIGENCE.CORE.REGION_REGISTRY.
// When the column is non-empty, loadPOIs filters POIs to those countries (eliminates border-bbox
// leakage). When NULL/empty, no country filter is applied and the job relies on the snap-distance
// filter + probeRoutability for safety. Returns null on lookup failure (logged WARN, non-fatal).
async function fetchRegionCountryCodes(region: string, snowSql: SnowSqlFn): Promise<string[] | null> {
  if (!region) return null;
  const safe = region.replace(/'/g, "''");
  try {
    const rows = await snowSql(
      `SELECT COUNTRY_CODES FROM FLEET_INTELLIGENCE.CORE.REGION_REGISTRY WHERE REGION_NAME = '${safe}' LIMIT 1`,
      'FLEET_INTELLIGENCE', 'CORE',
    );
    const raw = rows?.[0]?.COUNTRY_CODES;
    if (raw == null) return null;
    const arr = Array.isArray(raw) ? raw : (typeof raw === 'string' ? JSON.parse(raw) : null);
    if (!Array.isArray(arr) || arr.length === 0) return null;
    return arr.map((c: unknown) => String(c).trim()).filter(Boolean);
  } catch (e: any) {
    log('WARN', 'Studio', `REGION_REGISTRY country lookup failed (continuing without country filter): ${e.message?.slice(0, 200)}`, {
      detail: { region },
    });
    return null;
  }
}

// Per-profile snap-distance threshold (metres) used by filterRoutablePois.
// Driving graphs are dense, so a snap > 300 m almost always means the point is
// off the active country graph (e.g. across a national border). Cycling/foot
// graphs are sparser and need a wider radius.
const SNAP_THRESHOLD_M_BY_PROFILE: Record<string, number> = {
  'driving-car': 300,
  'driving-hgv': 300,
  'cycling-regular': 2000,
  'cycling-electric': 2000,
  'cycling-mountain': 2000,
  'cycling-road': 2000,
  'foot-walking': 2000,
  'foot-hiking': 2000,
};

function snapThresholdForProfile(profile: string): number {
  return SNAP_THRESHOLD_M_BY_PROFILE[profile] ?? 2000;
}

// Find a MATRIX source point that actually snaps to a road on the active graph.
// `snapped_distance` is a per-destination property, so ONE snappable source is
// enough to read every destination's snap distance. The previous implementation
// used the bbox centroid, which for a continent-sized/irregular region lands in
// the ocean (e.g. Europe: ~55.7N/7.0E, the North Sea) - an unsnappable source
// makes MATRIX return nulls for every POI, so the filter dropped all 5000 and
// silently fell back to the unfiltered list. The loaded POIs are real Overture
// places on land near roads, so we probe a handful of evenly-spread candidates
// (tiny self-matrix per candidate) and use the first that snaps. No dependency
// on any polygon interior-point function (Snowflake has no ST_POINTONSURFACE,
// and ST_CENTROID of a multipolygon can also fall in water).
async function findRoutableSources(
  pois: POI[],
  profileEsc: string,
  regionEsc: string,
  snowSql: SnowSqlFn,
  want = 3,
): Promise<{ lng: number; lat: number }[]> {
  if (pois.length === 0) return [];
  // Probe more evenly-spread candidates than we need, keep the first `want`
  // that snap. Multiple, spatially-separated sources make the reachability
  // probe robust to a source that happens to sit on a small disconnected
  // component (island / enclave): a POI counts as routable if it is reachable
  // both ways from ANY source, so a single bad source cannot drop the mainland.
  const MAX_CANDIDATES = 12;
  const stride = Math.max(1, Math.floor(pois.length / MAX_CANDIDATES));
  const candidates: POI[] = [];
  for (let i = 0; i < pois.length && candidates.length < MAX_CANDIDATES; i += stride) {
    candidates.push(pois[i]);
  }
  const sources: { lng: number; lat: number }[] = [];
  for (const c of candidates) {
    if (sources.length >= want) break;
    const pt = `ARRAY_CONSTRUCT(ARRAY_CONSTRUCT(${c.lng}, ${c.lat}))`;
    const sql = `
      SELECT TO_VARCHAR(M:durations[0]) AS DURATIONS
      FROM (
        SELECT OPENROUTESERVICE_APP.CORE.MATRIX_TABULAR(
          '${profileEsc}', ${pt}, ${pt}, '${regionEsc}'
        ) AS M
      )`;
    try {
      const rows = await snowSql(sql);
      const rawDur = rows?.[0]?.DURATIONS;
      if (!rawDur) continue;
      const durations = JSON.parse(typeof rawDur === 'string' ? rawDur : String(rawDur));
      const d = Array.isArray(durations) ? durations[0] : null;
      if (d != null && Number.isFinite(Number(d))) {
        sources.push({ lng: c.lng, lat: c.lat });
      }
    } catch {
      // Try the next candidate; a single bad probe is non-fatal.
    }
  }
  return sources;
}

async function filterRoutablePois(
  pois: POI[],
  profile: string,
  region: string,
  bbox: { min_lat: number; max_lat: number; min_lng: number; max_lng: number },
  snowSql: SnowSqlFn,
  onProgressLog?: (msg: string) => void,
): Promise<POI[]> {
  if (pois.length === 0) return pois;

  const profileEsc = profile.replace(/'/g, "''");
  const regionEsc = region.replace(/'/g, "''");

  // Probe reachability from a few real, snappable POIs (see findRoutableSources).
  // A POI counts routable if reachable BOTH ways from ANY source, so multiple
  // spatially-separated sources make the probe robust to a source that lands on
  // a small disconnected component. If NO candidate snapped, the graph/region is
  // likely broken - keep the unfiltered list (the probe cannot be trusted).
  const sources = await findRoutableSources(pois, profileEsc, regionEsc, snowSql);
  const sourcesArr = 'ARRAY_CONSTRUCT(' +
    (sources.length
      ? sources.map(s => `ARRAY_CONSTRUCT(${s.lng}, ${s.lat})`).join(',')
      : `ARRAY_CONSTRUCT(${(bbox.min_lng + bbox.max_lng) / 2}, ${(bbox.min_lat + bbox.max_lat) / 2})`) +
    ')';
  const nSources = Math.max(1, sources.length);

  const BATCH_SIZE = 1000;
  const SNAP_THRESHOLD_M = snapThresholdForProfile(profile);
  const reachable = new Array<boolean>(pois.length).fill(false);
  let droppedNullDuration = 0;
  let droppedFarSnap = 0;
  let droppedOutbound = 0;

  for (let i = 0; i < pois.length; i += BATCH_SIZE) {
    const batch = pois.slice(i, i + BATCH_SIZE);
    const destsArr = 'ARRAY_CONSTRUCT(' +
      batch.map(p => `ARRAY_CONSTRUCT(${p.lng}, ${p.lat})`).join(',') +
      ')';
    // Inbound MI (sources x batch): MI:durations[s][j] + MI:destinations[j].snapped_distance.
    // Outbound MO (batch x sources): MO:durations[j][s]. A POI is only routable
    // for the solver if BOTH directions have a finite path (a point on a
    // disconnected stub can be reachable inbound but dead outbound).
    const sql = `
      SELECT TO_VARCHAR(MI:durations) AS DUR_IN,
             TO_VARCHAR(MI:destinations) AS DESTINATIONS,
             TO_VARCHAR(MO:durations) AS DUR_OUT
      FROM (
        SELECT OPENROUTESERVICE_APP.CORE.MATRIX_TABULAR('${profileEsc}', ${sourcesArr}, ${destsArr}, '${regionEsc}') AS MI,
               OPENROUTESERVICE_APP.CORE.MATRIX_TABULAR('${profileEsc}', ${destsArr}, ${sourcesArr}, '${regionEsc}') AS MO
      )
    `;
    try {
      const rows = await snowSql(sql);
      const rawDurIn = rows?.[0]?.DUR_IN;
      const rawDest = rows?.[0]?.DESTINATIONS;
      const rawDurOut = rows?.[0]?.DUR_OUT;
      if (!rawDurIn) {
        log('WARN', 'Studio', `POI filter batch ${i}-${i + batch.length}: empty result, keeping batch`);
        for (let j = 0; j < batch.length; j++) reachable[i + j] = true;
        continue;
      }
      const durIn = JSON.parse(typeof rawDurIn === 'string' ? rawDurIn : String(rawDurIn));
      const durOut = rawDurOut ? JSON.parse(typeof rawDurOut === 'string' ? rawDurOut : String(rawDurOut)) : [];
      const destinations = rawDest ? JSON.parse(typeof rawDest === 'string' ? rawDest : String(rawDest)) : [];
      if (!Array.isArray(durIn) || !Array.isArray(durIn[0])) {
        log('WARN', 'Studio', `POI filter batch ${i}: non-array durations, keeping batch`);
        for (let j = 0; j < batch.length; j++) reachable[i + j] = true;
        continue;
      }
      const fin = (v: unknown) => v != null && Number.isFinite(Number(v));
      for (let j = 0; j < batch.length; j++) {
        // snapped_distance is a per-destination property, source-independent.
        const dest = Array.isArray(destinations) ? destinations[j] : null;
        if (dest == null) { droppedNullDuration++; continue; }
        const snap = dest?.snapped_distance;
        if (snap == null || !Number.isFinite(Number(snap)) || Number(snap) > SNAP_THRESHOLD_M) {
          droppedFarSnap++; continue;
        }
        // Reachable inbound from any source?
        let anyIn = false, anyOut = false;
        for (let s = 0; s < nSources; s++) {
          if (!anyIn && fin(durIn[s]?.[j])) anyIn = true;
          if (!anyOut && fin(Array.isArray(durOut) ? durOut[j]?.[s] : undefined)) anyOut = true;
          if (anyIn && anyOut) break;
        }
        if (!anyIn) { droppedNullDuration++; continue; }
        if (!anyOut) { droppedOutbound++; continue; }
        reachable[i + j] = true;
      }
    } catch (e: any) {
      log('WARN', 'Studio', `POI filter batch ${i} failed (non-fatal): ${e.message?.slice(0, 200)}`);
      for (let j = 0; j < batch.length; j++) reachable[i + j] = true;
    }
  }

  const filtered = pois.filter((_p, i) => reachable[i]);
  const dropped = pois.length - filtered.length;
  log('INFO', 'Studio', `POI routability filter: ${filtered.length}/${pois.length} routable`, {
    detail: { dropped, droppedNullDuration, droppedFarSnap, droppedOutbound, profile, region, sources: sources.length, snapThresholdM: SNAP_THRESHOLD_M },
  });

  // Only fall back to the unfiltered pool when the probe cannot be trusted (no
  // source snapped -> region/graph mismatch) or almost nothing survived (the
  // dataset could not be seeded). For a continent-scale region where a large
  // share of POIs sit on islands / across the sea, dropping that share is the
  // CORRECT outcome, not a filter that is "too aggressive" - keeping the routable
  // subset is exactly what prevents the downstream VROOM code-3 solve aborts.
  const ROUTABLE_FLOOR = 50;
  if (sources.length === 0 || filtered.length < ROUTABLE_FLOOR) {
    const msg = `POI filter kept too few (${filtered.length}/${pois.length}); falling back to unfiltered list ` +
      (sources.length ? `(sources snapped but almost no POIs routable - probable graph mismatch)` : `(no candidate POI snapped to the graph - probable region/graph mismatch)`);
    log('WARN', 'Studio', msg);
    onProgressLog?.(`POI filter: ${filtered.length}/${pois.length} routable - unusable, using unfiltered list`);
    return pois;
  }

  onProgressLog?.(`POI filter: ${filtered.length}/${pois.length} routable (dropped ${droppedNullDuration} unreachable, ${droppedFarSnap} far-snap, ${droppedOutbound} outbound-dead)`);
  return filtered;
}

// Map an Overture BASIC_CATEGORY to a LOCATION_TYPE using the profile's
// declarative category_map (LOCATION_TYPE -> category lists, optional `_default`).
// No vehicle-type/mode branching: a new mode supplies its own category_map.
function mapCategoryToType(category: string, config: GenerationConfig): string {
  const map = config.category_map;
  if (!map) return 'LOCATION';
  for (const [locType, cats] of Object.entries(map)) {
    if (locType === '_default') continue;
    if (Array.isArray(cats) && cats.includes(category)) return locType;
  }
  return typeof map._default === 'string' ? map._default : 'LOCATION';
}

export async function loadPOIs(
  config: GenerationConfig,
  snowSql: SnowSqlFn,
  onLog?: (msg: string) => void,
): Promise<POI[]> {
  const { bbox } = config;
  const cats = config.poi_categories || ['restaurant', 'bar', 'hotel', 'corporate_or_business_office'];
  const catFilter = cats.map(c => `'${c}'`).join(',');
  const countryCodes = await fetchRegionCountryCodes(config.region, snowSql);
  const countryFilter = countryCodes && countryCodes.length
    ? `
      AND p.ADDRESSES[0]:country::STRING IN (${countryCodes.map(c => `'${c.replace(/'/g, "''")}'`).join(',')})`
    : '';
  const mBoundary = regionCatalogMatch('rc', `'${config.region.replace(/'/g, "''")}'`);
  // Spatially fair pool sample. A plain `LIMIT 5000` returns Overture's first
  // scan-order rows, which cluster in one corner for a continent-sized bbox
  // (e.g. Europe: 49% of POIs landed in a single H3 cell). Instead, number each
  // candidate within its H3 cell by RANDOM(), then round-robin over cells
  // (ORDER BY _rn, RANDOM()): take the 1st POI from every populated cell, then
  // the 2nd from every cell, etc. This spreads the pool across the whole region,
  // always fills to the cap when enough candidates exist, and inherently caps
  // dense metros with no tuning constant. Cell size adapts to region area.
  const h3Res = h3ResForArea(config.region_area_km2);
  const poiCap = poiCapForArea(config.region_area_km2);
  const sql = `
    WITH region_boundary AS (
      SELECT BOUNDARY
      FROM OPENROUTESERVICE_APP.CORE.REGION_CATALOG rc
      WHERE rc.BOUNDARY IS NOT NULL
        AND ${mBoundary.predicate}
      ORDER BY ${mBoundary.rank}
      LIMIT 1
    ),
    candidates AS (
      SELECT p.ID AS LOCATION_ID, p.NAMES::VARIANT:primary AS NAME,
             p.BASIC_CATEGORY AS CATEGORY,
             ST_Y(p.GEOMETRY) AS LAT, ST_X(p.GEOMETRY) AS LNG,
             ROW_NUMBER() OVER (
               PARTITION BY H3_POINT_TO_CELL_STRING(p.GEOMETRY, ${h3Res})
               ORDER BY RANDOM()
             ) AS _RN
      FROM OVERTURE_MAPS__PLACES.CARTO.PLACE p
        LEFT JOIN region_boundary rb ON TRUE
      WHERE ST_Y(p.GEOMETRY) BETWEEN ${bbox.min_lat} AND ${bbox.max_lat}
        AND ST_X(p.GEOMETRY) BETWEEN ${bbox.min_lng} AND ${bbox.max_lng}
        AND p.BASIC_CATEGORY IN (${catFilter})${countryFilter}
        AND COALESCE(ST_INTERSECTS(p.GEOMETRY, rb.BOUNDARY), TRUE)
    )
    SELECT LOCATION_ID, NAME, CATEGORY, LAT, LNG
    FROM candidates
    ORDER BY _RN, RANDOM()
    LIMIT ${poiCap}`;
  log('INFO', 'Studio', `Loading POIs from Overture Maps`, {
    detail: { categories: cats, bbox, mode: config.mode, region: config.region, countryCodes, h3Res, poiCap, sql: sql.trim().replace(/\s+/g, ' ') },
  });
  try {
    const rows = await snowSql(sql, 'OVERTURE_MAPS__PLACES', 'CARTO');
    if (rows.length > 0) {
      const pois = rows.map((r: any) => ({
        location_id: r.LOCATION_ID || uuid(Math.random),
        name: r.NAME || 'Unknown',
        location_type: mapCategoryToType(r.CATEGORY || '', config),
        lat: Number(r.LAT),
        lng: Number(r.LNG),
        category: r.CATEGORY || '',
      }));
      const catCounts: Record<string, number> = {};
      const typeCounts: Record<string, number> = {};
      for (const p of pois) {
        catCounts[p.category] = (catCounts[p.category] || 0) + 1;
        typeCounts[p.location_type] = (typeCounts[p.location_type] || 0) + 1;
      }
      log('INFO', 'Studio', `Loaded ${pois.length} POIs from Overture Maps`, {
        detail: { source: 'overture', categories: catCounts, types: typeCounts },
      });
      const sanitized = await filterRoutablePois(pois, config.ors_profile, config.region, bbox, snowSql, onLog);
      return sanitized;
    }
    log('ERROR', 'Studio', `Overture Maps returned 0 POIs for bbox`, {
      detail: { bbox, categories: cats },
    });
    throw new Error(
      `No POIs found in Overture Maps for region bbox ` +
      `[${bbox.min_lat},${bbox.min_lng} to ${bbox.max_lat},${bbox.max_lng}] ` +
      `with categories [${cats.join(', ')}]. Expand the bbox or change categories.`
    );
  } catch (e: any) {
    if (e.message?.startsWith('No POIs found')) throw e;
    log('ERROR', 'Studio', `Overture Maps query failed`, {
      detail: { error: e.message?.slice(0, 200), bbox, categories: cats },
    });
    throw new Error(
      `Cannot load POIs: Overture Maps is not accessible. ` +
      `Ensure the OVERTURE_MAPS__PLACES share is mounted. Error: ${e.message?.slice(0, 200)}`
    );
  }
}

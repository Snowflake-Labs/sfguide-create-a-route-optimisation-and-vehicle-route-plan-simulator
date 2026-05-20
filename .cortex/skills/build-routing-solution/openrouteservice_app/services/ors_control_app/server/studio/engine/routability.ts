// POI loading + routability filtering. Loads candidate POIs from Overture
// Maps clipped to the region polygon, then prunes to POIs that ORS can
// actually snap to a road on the active graph (eliminates border-bbox leakage).

import type { POI, SnowSqlFn } from './types.js';
import { GenerationConfig, uuid } from '../profiles.js';
import { log } from '../../diagnostics.js';

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

async function filterRoutablePois(
  pois: POI[],
  profile: string,
  region: string,
  bbox: { min_lat: number; max_lat: number; min_lng: number; max_lng: number },
  snowSql: SnowSqlFn,
  onProgressLog?: (msg: string) => void,
): Promise<POI[]> {
  if (pois.length === 0) return pois;

  const centerLat = (bbox.min_lat + bbox.max_lat) / 2;
  const centerLng = (bbox.min_lng + bbox.max_lng) / 2;
  const sourcesArr = `ARRAY_CONSTRUCT(ARRAY_CONSTRUCT(${centerLng}, ${centerLat}))`;
  const profileEsc = profile.replace(/'/g, "''");
  const regionEsc = region.replace(/'/g, "''");

  const BATCH_SIZE = 1000;
  const SNAP_THRESHOLD_M = snapThresholdForProfile(profile);
  const reachable = new Array<boolean>(pois.length).fill(false);
  let droppedNullDuration = 0;
  let droppedFarSnap = 0;

  for (let i = 0; i < pois.length; i += BATCH_SIZE) {
    const batch = pois.slice(i, i + BATCH_SIZE);
    const destsArr = 'ARRAY_CONSTRUCT(' +
      batch.map(p => `ARRAY_CONSTRUCT(${p.lng}, ${p.lat})`).join(',') +
      ')';
    const sql = `
      SELECT TO_VARCHAR(M:durations[0]) AS DURATIONS,
             TO_VARCHAR(M:destinations) AS DESTINATIONS
      FROM (
        SELECT OPENROUTESERVICE_APP.CORE.MATRIX_TABULAR(
          '${profileEsc}',
          ${sourcesArr},
          ${destsArr},
          '${regionEsc}'
        ) AS M
      )
    `;
    try {
      const rows = await snowSql(sql);
      const rawDur = rows?.[0]?.DURATIONS;
      const rawDest = rows?.[0]?.DESTINATIONS;
      if (!rawDur) {
        log('WARN', 'Studio', `POI filter batch ${i}-${i + batch.length}: empty result, keeping batch`);
        for (let j = 0; j < batch.length; j++) reachable[i + j] = true;
        continue;
      }
      const durations = JSON.parse(typeof rawDur === 'string' ? rawDur : String(rawDur));
      const destinations = rawDest ? JSON.parse(typeof rawDest === 'string' ? rawDest : String(rawDest)) : [];
      if (!Array.isArray(durations)) {
        log('WARN', 'Studio', `POI filter batch ${i}: non-array durations, keeping batch`);
        for (let j = 0; j < batch.length; j++) reachable[i + j] = true;
        continue;
      }
      for (let j = 0; j < batch.length; j++) {
        const d = durations[j];
        if (d == null || !Number.isFinite(Number(d))) {
          droppedNullDuration++;
          continue;
        }
        const dest = Array.isArray(destinations) ? destinations[j] : null;
        // Treat a null destination object as not routable: ORS could not snap the POI to any
        // road in the active graph. Older code kept these because snap was undefined.
        if (dest == null) {
          droppedNullDuration++;
          continue;
        }
        const snap = dest?.snapped_distance;
        if (snap == null || !Number.isFinite(Number(snap)) || Number(snap) > SNAP_THRESHOLD_M) {
          droppedFarSnap++;
          continue;
        }
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
    detail: { dropped, droppedNullDuration, droppedFarSnap, profile, region, source: [centerLng, centerLat], snapThresholdM: SNAP_THRESHOLD_M },
  });

  if (filtered.length < Math.max(50, Math.floor(pois.length * 0.5))) {
    const msg = `POI filter dropped too many (${dropped}/${pois.length}); falling back to unfiltered list (probable bbox-centroid mismatch with graph)`;
    log('WARN', 'Studio', msg);
    onProgressLog?.(`POI filter: ${filtered.length}/${pois.length} routable - too aggressive, using unfiltered list`);
    return pois;
  }

  onProgressLog?.(`POI filter: ${filtered.length}/${pois.length} routable (dropped ${droppedNullDuration} unreachable, ${droppedFarSnap} far-snap)`);
  return filtered;
}

function mapCategoryToType(category: string, mode: string): string {
  if (mode === 'food_delivery') {
    if (['restaurant', 'fast_food_restaurant', 'cafe', 'bakery', 'pizzaria', 'casual_eatery', 'coffee_shop', 'sandwich_shop', 'chicken_restaurant'].includes(category)) return 'RESTAURANT';
    return 'ADDRESS';
  }
  if (mode === 'trucking') {
    if (['warehouse', 'storage_facility', 'b2b_transportation_and_storage_service', 'industrial_facility_or_service'].includes(category)) return 'WAREHOUSE';
    if (['gas_station', 'parking', 'transportation_location', 'ground_transport_facility_or_service'].includes(category)) return 'REST_STOP';
    return 'DESTINATION';
  }
  return 'LOCATION';
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
  const sql = `
    WITH region_boundary AS (
      SELECT BOUNDARY
      FROM OPENROUTESERVICE_APP.CORE.REGION_CATALOG rc
      WHERE rc.BOUNDARY IS NOT NULL
        AND (UPPER(rc.LOOKUP_NAME) = UPPER('${config.region.replace(/'/g, "''")}')
             OR UPPER(rc.REGION_KEY) = UPPER('${config.region.replace(/'/g, "''")}'))
      ORDER BY COALESCE(rc.BOUNDARY_AREA_KM2, 1e15) ASC
      LIMIT 1
    )
    SELECT p.ID AS LOCATION_ID, p.NAMES::VARIANT:primary AS NAME,
           p.BASIC_CATEGORY AS CATEGORY,
           ST_Y(p.GEOMETRY) AS LAT, ST_X(p.GEOMETRY) AS LNG
    FROM OVERTURE_MAPS__PLACES.CARTO.PLACE p
      LEFT JOIN region_boundary rb ON TRUE
    WHERE ST_Y(p.GEOMETRY) BETWEEN ${bbox.min_lat} AND ${bbox.max_lat}
      AND ST_X(p.GEOMETRY) BETWEEN ${bbox.min_lng} AND ${bbox.max_lng}
      AND p.BASIC_CATEGORY IN (${catFilter})${countryFilter}
      AND COALESCE(ST_INTERSECTS(p.GEOMETRY, rb.BOUNDARY), TRUE)
    LIMIT 5000`;
  log('INFO', 'Studio', `Loading POIs from Overture Maps`, {
    detail: { categories: cats, bbox, mode: config.mode, region: config.region, countryCodes, sql: sql.trim().replace(/\s+/g, ' ') },
  });
  try {
    const rows = await snowSql(sql, 'OVERTURE_MAPS__PLACES', 'CARTO');
    if (rows.length > 0) {
      const pois = rows.map((r: any) => ({
        location_id: r.LOCATION_ID || uuid(Math.random),
        name: r.NAME || 'Unknown',
        location_type: mapCategoryToType(r.CATEGORY || '', config.mode),
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

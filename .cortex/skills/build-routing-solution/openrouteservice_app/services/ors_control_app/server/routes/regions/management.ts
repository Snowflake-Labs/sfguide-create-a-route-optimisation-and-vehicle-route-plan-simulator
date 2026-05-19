// Region management endpoints — catalog, provisioning, progress, lifecycle.
// Catalog routes are large because /api/regions/catalog/refresh refreshes
// the geofabrik PBF download list and bake state.
// Provision routes wrap PROVISION_REGION_WRAPPER and the cancel/delete/diagnose
// procs. Progress routes poll log + service-status to drive the build UI.

import { Router } from 'express';
import { SF_DATABASE } from '../../constants.js';
import { runSql, callProcedure, submitSqlAsync, cancelStatement } from '../../lib/sql.js';
import { sanitizeIdentifier, sanitizeFloat, escapeString, toIso } from '../../lib/sanitize.js';
import { safeRegionIdent, orsServiceName, orsServiceFqn, DEFAULT_REGION_NAME } from '../../lib/region.js';
import { waitForOrsGraphReady, getExpectedProfiles } from '../../lib/ors.js';
import { log } from '../../diagnostics.js';

export function createRegionsManagementRouter(): Router {
  const router = Router();

  router.get('/api/regions/catalog', async (req, res) => {
    try {
      const search = (req.query.search as string || '').trim();
      const source = (req.query.source as string || '').trim();
      const level = (req.query.level as string || '').trim();
      let where = 'WHERE 1=1';
      if (search) where += ` AND LOWER(REGION_NAME) LIKE '%${escapeString(search.toLowerCase())}%'`;
      if (source) where += ` AND SOURCE = '${escapeString(source)}'`;
      if (level) where += ` AND LEVEL = '${escapeString(level)}'`;
      const rows = await runSql(`SELECT CATALOG_ID, SOURCE, REGION_NAME, REGION_KEY, HIERARCHY, CONTINENT, COUNTRY, PBF_URL, PBF_SIZE_MB, LEVEL, MIN_LAT, MAX_LAT, MIN_LON, MAX_LON FROM ${SF_DATABASE}.CORE.REGION_CATALOG ${where} QUALIFY ROW_NUMBER() OVER (PARTITION BY SOURCE, REGION_KEY, COALESCE(COUNTRY,'') ORDER BY CATALOG_ID) = 1 ORDER BY SOURCE, CONTINENT, COUNTRY, REGION_NAME`);
      res.json({ catalog: rows || [] });
    } catch (err: any) {
      res.json({ catalog: [], error: err.message });
    }
  });

  router.post('/api/regions/catalog/refresh', async (_req, res) => {
    const GEOFABRIK_BASE = 'https://download.geofabrik.de';
    const BBBIKE_BASE = 'https://download.bbbike.org/osm/bbbike';

    function parseSize(sizeStr: string): number | null {
      const m = sizeStr.trim().match(/^([\d.]+)\s*(MB|GB|KB|bytes)$/i);
      if (!m) return null;
      const val = parseFloat(m[1]);
      const unit = m[2].toUpperCase();
      if (unit === 'GB') return val * 1024;
      if (unit === 'KB') return val / 1024;
      if (unit === 'BYTES') return val / (1024 * 1024);
      return val;
    }

    function toRegionKey(name: string): string {
      return name.replace(/[-_]/g, ' ').split(/\s+/).map(w => w.charAt(0).toUpperCase() + w.slice(1)).join('').replace(/[^A-Za-z0-9]/g, '');
    }

    async function fetchPage(url: string): Promise<string> {
      try {
        const r = await fetch(url, { signal: AbortSignal.timeout(30000) });
        if (!r.ok) return '';
        return await r.text();
      } catch { return ''; }
    }

    interface CatalogRow {
      catalog_id: string; source: string; region_name: string; region_key: string;
      hierarchy: string | null; continent: string | null; country: string | null;
      pbf_url: string; pbf_size_mb: number | null; level: string;
      min_lat: number | null; max_lat: number | null; min_lon: number | null; max_lon: number | null;
    }

    type BboxLookup = Map<string, { min_lat: number; max_lat: number; min_lon: number; max_lon: number }>;

    async function fetchGeofabrikBboxIndex(): Promise<BboxLookup> {
      const lookup: BboxLookup = new Map();
      try {
        const resp = await fetch('https://download.geofabrik.de/index-v1.json', { signal: AbortSignal.timeout(30000) });
        if (!resp.ok) return lookup;
        const data = await resp.json() as any;
        for (const feature of data.features || []) {
          const id = feature.properties?.id;
          const geom = feature.geometry;
          if (!id || !geom?.coordinates) continue;
          const allPoints: number[][] = [];
          for (const poly of geom.coordinates) {
            for (const ring of poly) {
              if (Array.isArray(ring[0])) {
                for (const pt of ring) allPoints.push(pt as number[]);
              } else {
                allPoints.push(ring as number[]);
              }
            }
          }
          if (allPoints.length === 0) continue;
          const lons = allPoints.map(p => p[0]);
          const lats = allPoints.map(p => p[1]);
          lookup.set(id, {
            min_lat: Math.min(...lats), max_lat: Math.max(...lats),
            min_lon: Math.min(...lons), max_lon: Math.max(...lons),
          });
        }
      } catch {}
      return lookup;
    }

    function parseBBBikePoly(polyText: string): { min_lat: number; max_lat: number; min_lon: number; max_lon: number } | null {
      // BBBike .poly files are bbox rectangles (bbbike clips PBFs to a rectangle),
      // so extracting the four extents is sufficient.
      //
      // For full polygon boundaries (Geofabrik, MultiPolygon support, holes):
      // see scripts/region_catalog/build_boundaries.py. That offline bake
      // populates REGION_CATALOG.BOUNDARY for all ~460 shipped regions. Newly-
      // added regions discovered via this dynamic-refresh path will have a NULL
      // BOUNDARY column until the bake script is re-run and the seed parquet
      // re-committed. Downstream consumers fall back to bbox in that case.
      const coords: [number, number][] = [];
      for (const line of polyText.split('\n')) {
        const parts = line.trim().split(/\s+/);
        if (parts.length === 2) {
          const lon = parseFloat(parts[0]);
          const lat = parseFloat(parts[1]);
          if (!isNaN(lon) && !isNaN(lat)) coords.push([lon, lat]);
        }
      }
      if (coords.length === 0) return null;
      return {
        min_lat: Math.min(...coords.map(c => c[1])), max_lat: Math.max(...coords.map(c => c[1])),
        min_lon: Math.min(...coords.map(c => c[0])), max_lon: Math.max(...coords.map(c => c[0])),
      };
    }

    function parseGeofabrikIndex(html: string, basePath: string): Array<{ name: string; pbf_url: string; size_mb: number | null; sub_path: string; has_sub: boolean }> {
      const rows: Array<{ name: string; pbf_url: string; size_mb: number | null; sub_path: string; has_sub: boolean }> = [];
      const trBlocks = html.match(/<tr[^>]*>[\s\S]*?<\/tr>/gi) || [];
      // Geofabrik mixes two href conventions in the same site:
      //   (1) Root-relative full path on top-level pages, e.g. on /north-america.html the
      //       US row is href="north-america/us.html" and pbf is "north-america/us-latest.osm.pbf".
      //       Detected by cleanHref/rawSub starting with `bp + '/'`.
      //   (2) Dir-relative path on deeper pages, e.g. on /north-america/us.html the California row
      //       is href="us/california.html" and pbf is "us/california-latest.osm.pbf"
      //       (relative to /north-america/, NOT to /north-america/us/).
      //       Detected by cleanHref/rawSub starting with bp's last segment + '/'.
      //   (3) Absolute path: href="/russia.html" (Russia special case).
      // The previous implementation always resolved relative hrefs against the Geofabrik
      // root which produced 404 PBF URLs for every 3rd-level sub-region (US states,
      // Canadian provinces, German Lander, etc.). Russia survived because its href is absolute.
      const bp = basePath ? basePath.replace(/^\/|\/$/g, '') : '';
      const bpLast = bp ? (bp.split('/').pop() || '') : '';
      const bpParent = bp.includes('/') ? bp.split('/').slice(0, -1).join('/') : '';
      for (const block of trBlocks) {
        const pbfMatch = block.match(/<a\s+href="([^"]+\.osm\.pbf)"/i);
        if (!pbfMatch) continue;
        const pbfHref = pbfMatch[1];
        if (!pbfHref.includes('-latest')) continue;

        let link = '';
        let name = '';
        const subregionMatch = block.match(/<td[^>]*class="subregion"[^>]*>\s*<a\s+href="([^"]+)"[^>]*>([^<]+)<\/a>/i);
        if (subregionMatch) { link = subregionMatch[1]; name = subregionMatch[2].trim(); }
        else {
          const dirMatch = block.match(/<td[^>]*>\s*<a\s+href="([^"]+\/)"[^>]*>([^<]+)<\/a>/i);
          if (dirMatch) { link = dirMatch[1]; name = dirMatch[2].trim(); }
          else {
            const nameMatch = block.match(/<td[^>]*>\s*<a\s+href="[^"]*"[^>]*>([^<]+)<\/a>/i);
            if (nameMatch) { name = nameMatch[1].trim(); }
            else continue;
          }
        }

        const sizeMatch = block.match(/\((\d[\d.]*\s*(?:MB|GB|KB|bytes))\)/i);
        const sizeMb = sizeMatch ? parseSize(sizeMatch[1]) : null;

        let pbfUrl: string;
        if (pbfHref.startsWith('http')) {
          pbfUrl = pbfHref;
        } else if (pbfHref.startsWith('/')) {
          pbfUrl = GEOFABRIK_BASE + pbfHref;
        } else {
          const cleanHref = pbfHref.replace(/^\.\//,  '');
          if (!bp) {
            pbfUrl = GEOFABRIK_BASE + '/' + cleanHref;
          } else if (cleanHref.startsWith(bp + '/')) {
            // Convention (1): root-relative full path
            pbfUrl = GEOFABRIK_BASE + '/' + cleanHref;
          } else if (bpLast && cleanHref.startsWith(bpLast + '/')) {
            // Convention (2): dir-relative; resolve against parent of bp
            pbfUrl = GEOFABRIK_BASE + '/' + (bpParent ? bpParent + '/' : '') + cleanHref;
          } else {
            // Convention (3): purely relative to bp
            pbfUrl = GEOFABRIK_BASE + '/' + bp + '/' + cleanHref;
          }
        }

        const rawSub = link.replace(/\.html$/, '').replace(/^\.\//,  '').replace(/\/$/, '');
        let subPath: string;
        if (!rawSub || rawSub.startsWith('http') || rawSub.startsWith('/')) {
          subPath = rawSub;
        } else if (!bp) {
          subPath = rawSub;
        } else if (rawSub === bp || rawSub.startsWith(bp + '/')) {
          subPath = rawSub;
        } else if (bpLast && (rawSub === bpLast || rawSub.startsWith(bpLast + '/'))) {
          subPath = (bpParent ? bpParent + '/' : '') + rawSub;
        } else {
          subPath = bp + '/' + rawSub;
        }

        rows.push({ name, pbf_url: pbfUrl, size_mb: sizeMb, sub_path: subPath.replace(/^\/|\/$/g, ''), has_sub: !!(link && (link.endsWith('/') || link.endsWith('.html'))) });
      }
      return rows;
    }

    try {
      const allRows: CatalogRow[] = [];

      const gfBbox = await fetchGeofabrikBboxIndex();

      const html = await fetchPage(GEOFABRIK_BASE);
      const continents = parseGeofabrikIndex(html, '');

      for (const continent of continents) {
        const cname = continent.name;
        const cBbox = gfBbox.get(continent.sub_path);
        allRows.push({
          catalog_id: 'geofabrik:' + continent.sub_path, source: 'geofabrik',
          region_name: cname, region_key: toRegionKey(cname),
          hierarchy: '', continent: cname, country: null,
          pbf_url: continent.pbf_url, pbf_size_mb: continent.size_mb, level: 'continent',
          min_lat: cBbox?.min_lat ?? null, max_lat: cBbox?.max_lat ?? null,
          min_lon: cBbox?.min_lon ?? null, max_lon: cBbox?.max_lon ?? null,
        });

        if (!continent.has_sub || !continent.sub_path) continue;
        const subHtml = await fetchPage(GEOFABRIK_BASE + '/' + continent.sub_path + '.html');
        if (!subHtml) continue;
        const countries = parseGeofabrikIndex(subHtml, continent.sub_path);

        for (const country of countries) {
          const hierarchy = continent.sub_path + '/' + country.name.toLowerCase().replace(/ /g, '-');
          const coId = country.sub_path.split('/').pop() || country.name.toLowerCase().replace(/ /g, '-');
          const coBbox = gfBbox.get(coId) || gfBbox.get(country.sub_path.replace(/^.*\//, ''));
          allRows.push({
            catalog_id: 'geofabrik:' + hierarchy, source: 'geofabrik',
            region_name: country.name, region_key: toRegionKey(country.name),
            hierarchy: continent.sub_path, continent: cname, country: country.name,
            pbf_url: country.pbf_url, pbf_size_mb: country.size_mb, level: 'country',
            min_lat: coBbox?.min_lat ?? null, max_lat: coBbox?.max_lat ?? null,
            min_lon: coBbox?.min_lon ?? null, max_lon: coBbox?.max_lon ?? null,
          });

          if (!country.has_sub || !country.sub_path) continue;
          const sub2Html = await fetchPage(GEOFABRIK_BASE + '/' + country.sub_path + '.html');
          if (!sub2Html) continue;
          const subRegions = parseGeofabrikIndex(sub2Html, country.sub_path);

          for (const subReg of subRegions) {
            const srKey = subReg.sub_path;
            const srId = srKey.split('/').pop() || subReg.name.toLowerCase().replace(/ /g, '-');
            // Geofabrik bbox keys (index-v1.json) use various conventions across regions.
            // Try in order: full path, full path minus continent, last segment, lowercased name.
            const srBbox =
              gfBbox.get(srKey) ||
              gfBbox.get(srKey.split('/').slice(1).join('/')) ||
              gfBbox.get(srId) ||
              gfBbox.get(subReg.name.toLowerCase().replace(/ /g, '-'));
            allRows.push({
              catalog_id: 'geofabrik:' + country.sub_path + '/' + subReg.name.toLowerCase().replace(/ /g, '-'),
              source: 'geofabrik',
              region_name: subReg.name, region_key: toRegionKey(subReg.name),
              hierarchy: country.sub_path, continent: cname, country: country.name,
              pbf_url: subReg.pbf_url, pbf_size_mb: subReg.size_mb, level: 'sub-region',
              min_lat: srBbox?.min_lat ?? null, max_lat: srBbox?.max_lat ?? null,
              min_lon: srBbox?.min_lon ?? null, max_lon: srBbox?.max_lon ?? null,
            });
          }
        }
      }

      try {
        const bbResp = await fetch(BBBIKE_BASE + '/', { signal: AbortSignal.timeout(30000) });
        if (bbResp.ok) {
          const bbHtml = await bbResp.text();
          const cityDirs = bbHtml.match(/<a\s+href="([A-Z][A-Za-z0-9_-]+)\/"/g) || [];
          const seen = new Set<string>();
          const cities: string[] = [];
          for (const m of cityDirs) {
            const city = m.match(/href="([^"]+)\/"/)?.[1];
            if (!city || seen.has(city) || city.startsWith('.') || ['planet', 'update'].includes(city.toLowerCase())) continue;
            seen.add(city);
            cities.push(city);
          }
          const polyResults = await Promise.allSettled(
            cities.map(async (city) => {
              try {
                const pr = await fetch(`${BBBIKE_BASE}/${city}/${city}.poly`, { signal: AbortSignal.timeout(10000) });
                if (!pr.ok) return { city, bbox: null };
                return { city, bbox: parseBBBikePoly(await pr.text()) };
              } catch { return { city, bbox: null }; }
            })
          );
          const bbBboxMap = new Map<string, { min_lat: number; max_lat: number; min_lon: number; max_lon: number }>();
          for (const r of polyResults) {
            if (r.status === 'fulfilled' && r.value.bbox) bbBboxMap.set(r.value.city, r.value.bbox);
          }
          for (const city of cities) {
            const display = city.replace(/([a-z])([A-Z])/g, '$1 $2');
            const bb = bbBboxMap.get(city);
            allRows.push({
              catalog_id: 'bbbike:' + city, source: 'bbbike',
              region_name: display, region_key: city,
              hierarchy: null, continent: null, country: null,
              pbf_url: BBBIKE_BASE + '/' + city + '/' + city + '.osm.pbf',
              pbf_size_mb: null, level: 'city',
              min_lat: bb?.min_lat ?? null, max_lat: bb?.max_lat ?? null,
              min_lon: bb?.min_lon ?? null, max_lon: bb?.max_lon ?? null,
            });
          }
        }
      } catch {}

      const seenKeys = new Map<string, boolean>();
      for (let i = allRows.length - 1; i >= 0; i--) {
        const dk = `${allRows[i].source}:${allRows[i].region_key}:${allRows[i].country || ''}`;
        if (seenKeys.has(dk)) {
          allRows.splice(i, 1);
        } else {
          seenKeys.set(dk, true);
        }
      }

      const geofabrikCount = allRows.filter(r => r.source === 'geofabrik').length;
      const bbbikeCount = allRows.filter(r => r.source === 'bbbike').length;

      if (allRows.length > 0) {
        await runSql(`DELETE FROM ${SF_DATABASE}.CORE.REGION_CATALOG`);
        const batchSize = 100;
        for (let i = 0; i < allRows.length; i += batchSize) {
          const batch = allRows.slice(i, i + batchSize);
          const values = batch.map(r => {
            const esc = (v: string | null) => v === null ? 'NULL' : "'" + v.replace(/'/g, "''") + "'";
            const num = (v: number | null) => v === null ? 'NULL' : String(v);
            return `(${esc(r.catalog_id)},${esc(r.source)},${esc(r.region_name)},${esc(r.region_key)},${esc(r.hierarchy)},${esc(r.continent)},${esc(r.country)},${esc(r.pbf_url)},${num(r.pbf_size_mb)},${esc(r.level)},${num(r.min_lat)},${num(r.max_lat)},${num(r.min_lon)},${num(r.max_lon)},SYSDATE())`;
          }).join(',');
          await runSql(`INSERT INTO ${SF_DATABASE}.CORE.REGION_CATALOG (CATALOG_ID,SOURCE,REGION_NAME,REGION_KEY,HIERARCHY,CONTINENT,COUNTRY,PBF_URL,PBF_SIZE_MB,LEVEL,MIN_LAT,MAX_LAT,MIN_LON,MAX_LON,UPDATED_AT) VALUES ${values}`);
        }
      }

      res.json({ status: 'ok', result: { geofabrik_count: geofabrikCount, bbbike_count: bbbikeCount, total: allRows.length } });
    } catch (err: any) {
      res.status(500).json({ status: 'error', error: err.message });
    }
  });

  // Returns the largest high-memory SPCS instance family available in the
  // current cloud + region. Used by the UI to show users which family will
  // back any non-city XXL build before they click Deploy.
  router.get('/api/regions/largest-family', async (_req, res) => {
    try {
      const family = (await callProcedure('RESOLVE_LARGEST_HIGHMEM_FAMILY()')) || 'HIGHMEM_X64_M';
      res.json({ family: family.trim() });
    } catch (err: any) {
      res.status(500).json({ family: 'HIGHMEM_X64_M', error: err.message });
    }
  });

  // Healthcheck for the new build-routing-solution procedures and tables.
  // Surfaces partial deploys (e.g. image updated but SQL modules skipped) so
  // the UI can warn instead of silently degrading to hardcoded fallbacks.
  router.get('/api/regions/healthcheck', async (_req, res) => {
    const status: Record<string, 'ok' | 'missing' | 'error'> = {};
    const errors: Record<string, string> = {};

    const probes: { key: string; sql: string }[] = [
      { key: 'resolver',          sql: `CALL ${SF_DATABASE}.CORE.RESOLVE_LARGEST_HIGHMEM_FAMILY()` },
      { key: 'retry_strategy',    sql: `CALL ${SF_DATABASE}.CORE.RECOMMEND_RETRY_STRATEGY('__HEALTHCHECK__')` },
      { key: 'build_history',     sql: `SELECT 1 FROM ${SF_DATABASE}.CORE.ORS_BUILD_HISTORY LIMIT 1` },
      { key: 'build_spec',        sql: `SELECT ${SF_DATABASE}.CORE.BUILD_ORS_SERVICE_SPEC('X','XXL','false')` },
      { key: 'downsize_proc',     sql: `SHOW PROCEDURES LIKE 'DOWNSIZE_REGION_AFTER_BUILD' IN SCHEMA ${SF_DATABASE}.CORE` },
    ];

    await Promise.all(probes.map(async ({ key, sql }) => {
      try {
        const rows = await runSql(sql);
        if (key === 'downsize_proc') {
          status[key] = (rows && rows.length > 0) ? 'ok' : 'missing';
        } else {
          status[key] = 'ok';
        }
      } catch (err: any) {
        const msg = err?.message || String(err);
        if (/does not exist|not authorized|unknown function/i.test(msg)) {
          status[key] = 'missing';
        } else {
          status[key] = 'error';
          errors[key] = msg.slice(0, 200);
        }
      }
    }));

    const overall = Object.values(status).every((v) => v === 'ok') ? 'ok' : 'degraded';
    res.json({ overall, status, errors });
  });

  // Returns the recommended retry strategy for a region whose previous build
  // failed: REUSE / REBUILD_SAME / SPLIT_PROFILES / NO_HISTORY.
  router.get('/api/regions/:region/retry-strategy', async (req, res) => {
    try {
      const safeRegion = sanitizeIdentifier(req.params.region);
      const strategy = await callProcedure(`RECOMMEND_RETRY_STRATEGY('${safeRegion}')`);
      res.json({ region: safeRegion, strategy: (strategy || 'NO_HISTORY').trim() });
    } catch (err: any) {
      res.status(500).json({ strategy: 'NO_HISTORY', error: err.message });
    }
  });

  // Last 25 build attempts for a region from ORS_BUILD_HISTORY. Powers the UI
  // build-history card so users can see past compute size, instance family,
  // elapsed minutes, and exit status without inspecting Snowflake directly.
  router.get('/api/regions/:region/build-history', async (req, res) => {
    try {
      const safeRegion = sanitizeIdentifier(req.params.region);
      const rows = await runSql(
        `SELECT BUILD_ID, JOB_ID, REGION, INSTANCE_FAMILY, COMPUTE_SIZE,
                PROFILES, JVM_XMX_GIB, STARTED_AT, FINISHED_AT, ELAPSED_MINUTES,
                EXIT_STATUS, PEAK_RSS_GIB, OUTPUT_GRAPH_GIB
         FROM ${SF_DATABASE}.CORE.ORS_BUILD_HISTORY
         WHERE UPPER(REGION) = UPPER('${safeRegion}')
         ORDER BY STARTED_AT DESC
         LIMIT 25`
      );
      const history = (rows || []).map((r: any) => ({
        ...r,
        STARTED_AT: toIso(r.STARTED_AT),
        FINISHED_AT: toIso(r.FINISHED_AT),
      }));
      res.json({ region: safeRegion, history });
    } catch (err: any) {
      res.status(500).json({ region: req.params.region, history: [], error: err.message });
    }
  });

  router.get('/api/regions/provisioned', async (_req, res) => {
    try {
      const result = await callProcedure('LIST_REGIONS()');
      const regions = JSON.parse(result || '[]');
      const enriched = await Promise.all(regions.map(async (c: any) => {
        let serviceStatus = 'UNKNOWN';
        try {
          const rows = await runSql(`SHOW SERVICES LIKE '${orsServiceName(c.region)}' IN SCHEMA ${SF_DATABASE}.CORE`);
          serviceStatus = rows?.[0]?.status || 'NOT_FOUND';
        } catch { serviceStatus = 'NOT_FOUND'; }

        let bbox = c.bbox;
        let boundaryGeoJson: string | null = null;
        const bboxInvalid = !bbox
          || bbox.min_lat == null || bbox.max_lat == null || bbox.min_lon == null || bbox.max_lon == null
          || (bbox.min_lat === 0 && bbox.max_lat === 0 && bbox.min_lon === 0 && bbox.max_lon === 0);
        try {
          const safeRegion = sanitizeIdentifier(c.region);
          const catRows = await runSql(`SELECT MIN_LAT, MAX_LAT, MIN_LON, MAX_LON, CAST(ST_ASGEOJSON(BOUNDARY) AS VARCHAR) AS BOUNDARY_GEOJSON FROM ${SF_DATABASE}.CORE.REGION_CATALOG WHERE UPPER(REGION_KEY) = UPPER('${safeRegion}') OR UPPER(REGION_NAME) = UPPER('${safeRegion}') LIMIT 1`);
          const cat = catRows?.[0];
          if (cat) {
            if (bboxInvalid && cat.MIN_LAT != null && cat.MAX_LAT != null && cat.MIN_LON != null && cat.MAX_LON != null
                && !(cat.MIN_LAT === 0 && cat.MAX_LAT === 0 && cat.MIN_LON === 0 && cat.MAX_LON === 0)) {
              bbox = { min_lat: cat.MIN_LAT, max_lat: cat.MAX_LAT, min_lon: cat.MIN_LON, max_lon: cat.MAX_LON };
            }
            if (cat.BOUNDARY_GEOJSON) boundaryGeoJson = cat.BOUNDARY_GEOJSON;
          }
        } catch {}

        let graphReadiness: any = null;
        if (serviceStatus === 'RUNNING' || serviceStatus === 'READY') {
          try {
            const safeRegion = sanitizeIdentifier(c.region);
            const orsRows = await runSql(`SELECT TO_VARCHAR(${SF_DATABASE}.CORE.ORS_STATUS('${safeRegion}')) AS S`);
            const raw = orsRows?.[0]?.S;
            if (raw) {
              const data = typeof raw === 'string' ? JSON.parse(raw) : raw;
              const builtProfiles = Object.keys(data.profiles || {});
              const expectedProfiles = await getExpectedProfiles(c.region);
              const allProfiles = [...new Set([...expectedProfiles, ...builtProfiles])];
              graphReadiness = {
                service_ready: data.service_ready ?? false,
                profiles_loaded: builtProfiles,
                expected_profiles: expectedProfiles,
                graphs: allProfiles.map((p: string) => ({
                  profile: p,
                  ready: builtProfiles.includes(p),
                  build_date: (data.bounds_info || {})[p]?.graph_build_date || null,
                })),
              };
            }
          } catch (e: any) {
            graphReadiness = { service_ready: false, error: e.message, profiles_loaded: [], expected_profiles: [], graphs: [] };
          }
        }

        return { ...c, bbox, boundaryGeoJson, serviceStatus, functionExists: true, graphReadiness };
      }));

      let defaultStatus = 'NOT_FOUND';
      try {
        // v1.1.0: legacy bare ORS_SERVICE was renamed to ORS_SERVICE_SANFRANCISCO
        // (the per-region default). Probe both for migration robustness.
        const rows = await runSql(`SHOW SERVICES LIKE 'ORS_SERVICE_SANFRANCISCO' IN SCHEMA ${SF_DATABASE}.CORE`);
        defaultStatus = rows?.[0]?.status || 'NOT_FOUND';
      } catch {}
      let defaultGraphReadiness: any = null;
      if (defaultStatus === 'RUNNING' || defaultStatus === 'READY') {
        try {
          const orsRows = await runSql(`SELECT TO_VARCHAR(${SF_DATABASE}.CORE.ORS_STATUS()) AS S`);
          const raw = orsRows?.[0]?.S;
          if (raw) {
            const data = typeof raw === 'string' ? JSON.parse(raw) : raw;
            const builtProfiles = Object.keys(data.profiles || {});
            const expectedProfiles = await getExpectedProfiles('default');
            const allProfiles = [...new Set([...expectedProfiles, ...builtProfiles])];
            defaultGraphReadiness = {
              service_ready: data.service_ready ?? false,
              profiles_loaded: builtProfiles,
              expected_profiles: expectedProfiles,
              graphs: allProfiles.map((p: string) => ({
                profile: p,
                ready: builtProfiles.includes(p),
                build_date: (data.bounds_info || {})[p]?.graph_build_date || null,
              })),
            };
          }
        } catch (e: any) {
          defaultGraphReadiness = { service_ready: false, error: e.message, profiles_loaded: [], expected_profiles: [], graphs: [] };
        }
      }
      if (defaultStatus !== 'NOT_FOUND') {
        let defaultBoundaryGeoJson: string | null = null;
        try {
          const catRows = await runSql(`SELECT CAST(ST_ASGEOJSON(BOUNDARY) AS VARCHAR) AS BOUNDARY_GEOJSON FROM ${SF_DATABASE}.CORE.REGION_CATALOG WHERE UPPER(REGION_KEY) = 'SAN_FRANCISCO' OR UPPER(REGION_KEY) = 'DEFAULT' OR UPPER(REGION_NAME) = 'SAN FRANCISCO' LIMIT 1`);
          defaultBoundaryGeoJson = catRows?.[0]?.BOUNDARY_GEOJSON ?? null;
        } catch {}
        enriched.unshift({
          region: 'default',
          effectiveRegion: DEFAULT_REGION_NAME,
          display_name: 'San Francisco (Default)',
          status: 'DEPLOYED',
          serviceStatus: defaultStatus,
          functionExists: true,
          isDefault: true,
          bbox: { min_lat: 37.71, max_lat: 37.81, min_lon: -122.51, max_lon: -122.37 },
          boundaryGeoJson: defaultBoundaryGeoJson,
          graphReadiness: defaultGraphReadiness,
        });
      }

      res.json({ regions: enriched });
    } catch (err: any) {
      res.json({ regions: [], error: err.message });
    }
  });

  router.post('/api/regions/provision', async (req, res) => {
    const { city, region, pbf_url, bbox, profiles, compute_size, force_redownload_pbf } = req.body;
    if (!region) return res.status(400).json({ error: 'region required' });

    let safeRegion: string;
    let safeCity: string;
    try {
      safeRegion = sanitizeIdentifier(region);
      safeCity = escapeString(city || region);
      sanitizeFloat(bbox?.minLat);
      sanitizeFloat(bbox?.maxLat);
      sanitizeFloat(bbox?.minLon);
      sanitizeFloat(bbox?.maxLon);
    } catch (err: any) {
      return res.status(400).json({ error: `Invalid input: ${err.message}` });
    }

    const safePbfUrl = escapeString(pbf_url || '');
    const minLat = sanitizeFloat(bbox.minLat);
    const maxLat = sanitizeFloat(bbox.maxLat);
    const minLon = sanitizeFloat(bbox.minLon);
    const maxLon = sanitizeFloat(bbox.maxLon);

    const defaultProfiles = 'driving-car,driving-hgv,cycling-electric';
    const validProfiles = ['driving-car', 'driving-hgv', 'cycling-regular', 'cycling-road', 'cycling-mountain', 'cycling-electric', 'foot-walking', 'foot-hiking', 'wheelchair'];
    const selectedProfiles = Array.isArray(profiles)
      ? profiles.filter((p: string) => validProfiles.includes(p)).join(',')
      : defaultProfiles;
    const safeProfiles = escapeString(selectedProfiles || defaultProfiles);
    // Allow legacy tiers (M/L/XL) for the UI advanced override; default to XXL for any non-city
    // request that arrives without a recognized tier so we never silently downgrade large regions.
    const ALLOWED_SIZES = ['S', 'M', 'L', 'XL', 'XXL'] as const;
    const safeComputeSize = (ALLOWED_SIZES as readonly string[]).includes(compute_size) ? compute_size : 'XXL';
    // PBF cache control: when true, skip the on-stage probe in
    // PROVISION_REGION_WRAPPER and always re-download from the upstream URL.
    // Defaults to false so cached files (e.g. weekly Geofabrik snapshots already
    // staged) are reused, which makes redeploys complete in seconds.
    const safeForceRedownload = force_redownload_pbf === true ? 'TRUE' : 'FALSE';

    const jobId = `PROVISION_${safeRegion}_${Date.now()}`.toUpperCase();

    try {
      await runSql(`INSERT INTO ${SF_DATABASE}.CORE.REGION_PROVISION_JOBS (JOB_ID, REGION, DISPLAY_NAME, PBF_URL, PROFILES, STATUS, STAGE) VALUES ('${escapeString(jobId)}', '${safeRegion}', '${safeCity}', '${safePbfUrl}', '${safeProfiles}', 'PENDING', 'NOT_STARTED')`);
    } catch (err: any) {
      return res.status(500).json({ error: `Failed to create job: ${err.message}` });
    }

    res.json({ status: 'launched', job_id: jobId });

    try {
      const callSql = `CALL ${SF_DATABASE}.CORE.PROVISION_REGION_WRAPPER('${escapeString(jobId)}', '${safeRegion}', '${safeCity}', '${safePbfUrl}', ${minLat}, ${maxLat}, ${minLon}, ${maxLon}, '${safeProfiles}', '${safeComputeSize}', ${safeForceRedownload})`;
      const handle = await submitSqlAsync(callSql);
      await runSql(`UPDATE ${SF_DATABASE}.CORE.REGION_PROVISION_JOBS SET STATEMENT_HANDLE='${escapeString(handle)}' WHERE JOB_ID='${escapeString(jobId)}'`);
    } catch (e: any) {
      console.error(`[provision] async launch error: ${e.message}`);
    }
  });

  router.get('/api/regions/provision/status', async (_req, res) => {
    try {
      const result = await callProcedure('GET_PROVISION_STATUS()');
      const jobs = JSON.parse(result || '[]');
      res.json({ jobs });
    } catch (err: any) {
      res.json({ jobs: [], error: err.message });
    }
  });

  router.post('/api/regions/provision/:jobId/dismiss', async (req, res) => {
    try {
      const jobId = sanitizeIdentifier(req.params.jobId);
      await callProcedure(`DISMISS_PROVISION_JOB('${jobId}')`);
      res.json({ success: true });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  router.get('/api/regions/:region/progress', async (req, res) => {
    try {
      const safeRegion = sanitizeIdentifier(req.params.region);
      const result = await callProcedure('GET_PROVISION_STATUS()');
      const jobs = JSON.parse(result || '[]');
      const job = jobs.find((j: any) => j.region === safeRegion && (j.status === 'RUNNING' || j.status === 'PENDING'));
      if (job) {
        res.json({ status: job.status === 'RUNNING' ? 'running' : job.status, phase: job.stage.toLowerCase(), message: job.message, error: job.error_msg });
      } else {
        const completed = jobs.find((j: any) => j.region === safeRegion);
        res.json(completed ? { status: completed.status.toLowerCase(), phase: completed.stage.toLowerCase(), message: completed.message } : { status: 'idle', phase: '' });
      }
    } catch { res.json({ status: 'idle', phase: '' }); }
  });

  router.get('/api/regions/:region/build-progress', async (req, res) => {
    try {
      const safeRegion = sanitizeIdentifier(req.params.region);
      const svcName = orsServiceFqn(req.params.region);

      // Fast path: ORS_STATUS is the source of truth. If the service reports ready
      // with profiles loaded, return 'ready' immediately. Avoids unreliable log
      // tail scraping for long-running builds where start/finish markers have
      // rolled out of the 1000-line window (Issue: UI stuck on "ORS starting up...").
      try {
        const statusRows = await runSql(
          `SELECT ${SF_DATABASE}.CORE.ORS_STATUS('${safeRegion}')::VARCHAR AS S`
        );
        const statusRaw = statusRows?.[0]?.S;
        if (statusRaw) {
          const parsed = JSON.parse(statusRaw);
          if (parsed?.service_ready === true && parsed?.profiles) {
            const loaded = Object.keys(parsed.profiles);
            if (loaded.length > 0) {
              res.json({
                phase: 'ready',
                progress: 100,
                completedProfiles: loaded,
                totalProfiles: loaded.length,
                currentProfile: null,
              });
              return;
            }
          }
        }
      } catch {
        // fall through to log-based scraping
      }

      const rows = await runSql(
        `SELECT SYSTEM$GET_SERVICE_LOGS('${svcName}', 0, 'ors', 1000) AS LOGS`
      );
      const logs: string = rows?.[0]?.LOGS || '';

      // ORS v9 logs profile completion as "[N] Profiles: 'name', location: ..." (plural).
      const finishedProfiles = [...logs.matchAll(/\[\d+\] Profiles?: '([\w-]+)'/g)].map(m => m[1]);
      const startedProfiles = [...logs.matchAll(/ORS-pl-([\w-]+)/g)].map(m => m[1]);
      const uniqueStarted = [...new Set(startedProfiles)];
      const totalProfiles = Math.max(uniqueStarted.length, finishedProfiles.length);
      const lastStarted = uniqueStarted.length > 0 ? uniqueStarted[uniqueStarted.length - 1] : null;
      const currentProfile = lastStarted && !finishedProfiles.includes(lastStarted) ? lastStarted : null;

      if (finishedProfiles.length === totalProfiles && totalProfiles > 0 && !currentProfile) {
        const healthOk = logs.includes('Started Application');
        res.json({
          phase: healthOk ? 'ready' : 'finalizing',
          progress: healthOk ? 100 : 99,
          completedProfiles: finishedProfiles,
          totalProfiles,
          currentProfile: null,
        });
        return;
      }

      const nodeLines = [...logs.matchAll(/edge,\s*nodes:\s*([\d\s]+\d),\s*shortcuts:\s*([\d\s]+\d)/g)];

      const profileTagEsc = currentProfile ? `ORS-pl-${currentProfile}`.replace(/[-/]/g, '\\$&') : null;
      const hasImport = profileTagEsc ? new RegExp(`${profileTagEsc}.*?start creating graph`).test(logs) : false;
      const hasCH = profileTagEsc ? new RegExp(`${profileTagEsc}.*?Creating CH preparations`).test(logs) : false;
      const hasLM = profileTagEsc ? new RegExp(`${profileTagEsc}.*?Creating LM preparations`).test(logs) : false;

      if (nodeLines.length === 0 || !hasCH) {
        const started = logs.includes('Starting Application') || logs.includes('Spring Boot');
        let phase = 'waiting';
        if (started) {
          if (hasImport) phase = 'importing';
          else if (currentProfile) phase = 'initializing';
          else phase = 'initializing';
        }
        res.json({
          phase,
          progress: totalProfiles > 0 ? Math.round((finishedProfiles.length / totalProfiles) * 100) : 0,
          completedProfiles: finishedProfiles,
          totalProfiles,
          currentProfile,
        });
        return;
      }

      if (hasLM) {
        const overallProgress = totalProfiles > 0
          ? Math.round(((finishedProfiles.length + 0.95) / totalProfiles) * 100)
          : 95;
        res.json({
          phase: 'building',
          progress: Math.min(overallProgress, 99),
          profileProgress: 95,
          currentProfile,
          completedProfiles: finishedProfiles,
          totalProfiles,
          detail: 'Landmark preparation',
        });
        return;
      }

      const parseNum = (s: string) => parseInt(s.replace(/\s/g, ''), 10);
      const firstNodes = parseNum(nodeLines[0][1]);
      const lastNodes = parseNum(nodeLines[nodeLines.length - 1][1]);
      const profileProgress = firstNodes > 0 ? (1 - lastNodes / firstNodes) : 0;
      const overallProgress = totalProfiles > 0
        ? Math.round(((finishedProfiles.length + profileProgress * 0.9) / totalProfiles) * 100)
        : Math.round(profileProgress * 90);

      res.json({
        phase: 'building',
        progress: Math.min(overallProgress, 99),
        profileProgress: Math.min(Math.round(profileProgress * 100), 99),
        nodesRemaining: lastNodes,
        nodesTotal: firstNodes,
        currentProfile,
        completedProfiles: finishedProfiles,
        totalProfiles,
      });
    } catch (err: any) {
      res.json({ phase: 'unknown', progress: 0, error: err.message });
    }
  });

  router.post('/api/regions/:region/cancel', async (req, res) => {
    try {
      const safeRegion = sanitizeIdentifier(req.params.region);
      const result = await callProcedure('GET_PROVISION_STATUS()');
      const jobs = JSON.parse(result || '[]');
      const active = jobs.find((j: any) => j.region === safeRegion && (j.status === 'RUNNING' || j.status === 'PENDING'));
      if (active?.statement_handle) await cancelStatement(active.statement_handle);
      await runSql(`UPDATE ${SF_DATABASE}.CORE.REGION_PROVISION_JOBS SET STATUS='CANCELLED', COMPLETED_AT=SYSDATE() WHERE REGION='${safeRegion}' AND STATUS IN ('RUNNING','PENDING')`);
      res.json({ status: 'cancelled' });
    } catch (err: any) { res.status(500).json({ error: err.message }); }
  });

  router.delete('/api/regions/:region', async (req, res) => {
    try {
      const safeRegion = sanitizeIdentifier(req.params.region);
      const result = await callProcedure(`DROP_REGION_ORS('${safeRegion}')`);
      await runSql(`UPDATE ${SF_DATABASE}.CORE.REGION_PROVISION_JOBS SET STATUS='CANCELLED', COMPLETED_AT=SYSDATE() WHERE REGION='${safeRegion}' AND STATUS IN ('RUNNING','PENDING')`);
      res.json({ status: 'ok', result });
    } catch (err: any) {
      res.json({ status: 'error', error: err.message });
    }
  });

  // One-click diagnostic agent. Calls DIAGNOSE_REGION which gathers an 8-source
  // snapshot and asks AI_COMPLETE for a markdown diagnosis. 30s server-side cache
  // per region absorbs spam clicks. See docs/plans/in-app-diagnostic-agent.md.
  router.post('/api/regions/:region/diagnose', async (req, res) => {
    let safeRegion: string;
    try {
      safeRegion = sanitizeIdentifier(req.params.region);
    } catch (err: any) {
      return res.status(400).json({ ok: false, error: `Invalid region: ${err.message}` });
    }
    const now = Date.now();
    const cacheKey = `diag:${safeRegion}`;
    const cached = (globalThis as any).__diagCache?.[cacheKey];
    if (cached && now - cached.ts < 30_000) {
      return res.json(cached.payload);
    }
    try {
      const result = await callProcedure(`DIAGNOSE_REGION('${safeRegion}')`);
      const parsed = JSON.parse(result || '{}');
      const payload = { ok: true, ...parsed };
      (globalThis as any).__diagCache = (globalThis as any).__diagCache || {};
      (globalThis as any).__diagCache[cacheKey] = { ts: now, payload };
      res.json(payload);
    } catch (err: any) {
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  return router;
}

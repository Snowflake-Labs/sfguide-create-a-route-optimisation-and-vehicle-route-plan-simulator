// Region catalog endpoints — list catalog rows and refresh the geofabrik /
// bbbike PBF download index. The refresh handler is large because it parses
// HTML index pages, fetches bbox metadata, and bulk-INSERTs into REGION_CATALOG.
//
// For full polygon boundaries (Geofabrik MultiPolygon support, holes):
// see scripts/region_catalog/build_boundaries.py — that offline bake populates
// REGION_CATALOG.BOUNDARY for shipped regions. Newly discovered regions via
// this dynamic-refresh path will have NULL BOUNDARY until the bake re-runs.

import { Router } from 'express';
import { SF_DATABASE } from '../../constants.js';
import { runSql } from '../../lib/sql.js';
import { escapeString } from '../../lib/sanitize.js';

export function createRegionsCatalogRouter(): Router {
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
            pbfUrl = GEOFABRIK_BASE + '/' + cleanHref;
          } else if (bpLast && cleanHref.startsWith(bpLast + '/')) {
            pbfUrl = GEOFABRIK_BASE + '/' + (bpParent ? bpParent + '/' : '') + cleanHref;
          } else {
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

  return router;
}


// Read-only test harness for Geofabrik catalog parser fix.
// Runs OLD parser (current production logic) and NEW parser (proposed fix)
// against live Geofabrik HTML, diffs them, and validates against the
// baseline-catalog.jsonl snapshot exported from REGION_CATALOG.
//
// Run: node run.mjs

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const GEOFABRIK_BASE = 'https://download.geofabrik.de';
const BBBIKE_BASE    = 'https://download.bbbike.org/osm/bbbike';

// ---------- Shared helpers (identical between old/new) ----------

function parseSize(str) {
  const m = str.match(/(\d[\d.]*)/);
  if (!m) return null;
  const val = parseFloat(m[1]);
  const unit = str.replace(/\d|\.|\s/g, '').toUpperCase();
  if (unit === 'GB') return val * 1024;
  if (unit === 'KB') return val / 1024;
  if (unit === 'BYTES') return val / (1024 * 1024);
  return val;
}

function toRegionKey(name) {
  return name.replace(/[-_]/g, ' ').split(/\s+/).map(w => w.charAt(0).toUpperCase() + w.slice(1)).join('').replace(/[^A-Za-z0-9]/g, '');
}

const pageCache = new Map();
async function fetchPage(url) {
  if (pageCache.has(url)) return pageCache.get(url);
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(30000) });
    const txt = r.ok ? await r.text() : '';
    pageCache.set(url, txt);
    return txt;
  } catch (e) {
    pageCache.set(url, '');
    return '';
  }
}

async function fetchGeofabrikBboxIndex() {
  const lookup = new Map();
  try {
    const resp = await fetch('https://download.geofabrik.de/index-v1.json', { signal: AbortSignal.timeout(30000) });
    if (!resp.ok) return lookup;
    const data = await resp.json();
    for (const feature of data.features || []) {
      const id = feature.properties?.id;
      const geom = feature.geometry;
      if (!id || !geom?.coordinates) continue;
      const allPoints = [];
      for (const poly of geom.coordinates) {
        for (const ring of poly) {
          if (Array.isArray(ring[0])) for (const pt of ring) allPoints.push(pt);
          else allPoints.push(ring);
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



const parseGeofabrikIndex_INTREE = function (html, basePath) {
    const rows = [];
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

      let pbfUrl;
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
      let subPath;
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
    return rows;};

export { parseGeofabrikIndex_INTREE, GEOFABRIK_BASE, BBBIKE_BASE, fetchPage, fetchGeofabrikBboxIndex, toRegionKey, parseSize };

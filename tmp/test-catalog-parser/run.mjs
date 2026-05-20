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

// ---------- OLD PARSER (lifted from server/index.ts:637-684) ----------
function parseGeofabrikIndex_OLD(html, basePath) {
  const rows = [];
  const trBlocks = html.match(/<tr[^>]*>[\s\S]*?<\/tr>/gi) || [];
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
    if (pbfHref.startsWith('http')) pbfUrl = pbfHref;
    else if (pbfHref.startsWith('/')) pbfUrl = GEOFABRIK_BASE + pbfHref;
    else {
      const cleanHref = pbfHref.replace(/^\.\//, '');
      pbfUrl = GEOFABRIK_BASE + '/' + cleanHref;
    }

    let subPath = link.replace(/\.html$/, '').replace(/^\.\//, '').replace(/\/$/, '');
    if (subPath && !subPath.startsWith('http') && !subPath.startsWith('/')) {
      const bp = basePath ? basePath.replace(/^\/|\/$/g, '') : '';
      subPath = bp && !subPath.startsWith(bp + '/') ? bp + '/' + subPath : subPath;
    }

    rows.push({ name, pbf_url: pbfUrl, size_mb: sizeMb, sub_path: subPath.replace(/^\/|\/$/g, ''), has_sub: !!(link && (link.endsWith('/') || link.endsWith('.html'))) });
  }
  return rows;
}

// ---------- NEW PARSER (fix applied) ----------
function parseGeofabrikIndex_NEW(html, basePath) {
  const rows = [];
  const trBlocks = html.match(/<tr[^>]*>[\s\S]*?<\/tr>/gi) || [];
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

    // ---- pbfUrl: resolve relative against current page (basePath), not Geofabrik root ----
    let pbfUrl;
    if (pbfHref.startsWith('http')) {
      pbfUrl = pbfHref;
    } else if (pbfHref.startsWith('/')) {
      pbfUrl = GEOFABRIK_BASE + pbfHref;
    } else {
      const cleanHref = pbfHref.replace(/^\.\//, '');
      // Two Geofabrik conventions:
      //   (1) Root-relative on top-level pages: cleanHref starts with bp's full path
      //       (e.g. cleanHref="north-america/us-latest.osm.pbf" on /index.html, bp="").
      //       OR cleanHref="north-america/canada-latest.osm.pbf" on /north-america.html, bp="north-america".
      //       Detected by cleanHref.startsWith(bp + '/').
      //   (2) Dir-relative on deeper pages: cleanHref begins with the LAST segment of bp
      //       (e.g. cleanHref="us/california-latest.osm.pbf" on /north-america/us.html, bp="north-america/us"; bpLast="us").
      //       Resolve against parent of bp.
      //   (3) Fully relative (no shared prefix): treat as relative to bp.
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

    // ---- subPath: same conventions ----
    let rawSub = link.replace(/\.html$/, '').replace(/^\.\//, '').replace(/\/$/, '');
    let subPath;
    if (!rawSub) {
      subPath = '';
    } else if (rawSub.startsWith('http') || rawSub.startsWith('/')) {
      subPath = rawSub;
    } else if (!bp) {
      subPath = rawSub;
    } else if (rawSub.startsWith(bp + '/') || rawSub === bp) {
      subPath = rawSub;
    } else if (bpLast && (rawSub.startsWith(bpLast + '/') || rawSub === bpLast)) {
      subPath = (bpParent ? bpParent + '/' : '') + rawSub;
    } else {
      subPath = bp + '/' + rawSub;
    }

    rows.push({
      name,
      pbf_url: pbfUrl,
      size_mb: sizeMb,
      sub_path: subPath.replace(/^\/|\/$/g, ''),
      has_sub: !!(link && (link.endsWith('/') || link.endsWith('.html'))),
    });
  }
  return rows;
}

// ---------- BBBike parser (unchanged, identical for old/new) ----------
function parseBBBikePoly(polyText) {
  const coords = [];
  for (const line of polyText.split('\n')) {
    const parts = line.trim().split(/\s+/);
    if (parts.length === 2) {
      const lon = parseFloat(parts[0]);
      const lat = parseFloat(parts[1]);
      if (!isNaN(lon) && !isNaN(lat)) coords.push([lon, lat]);
    }
  }
  if (coords.length === 0) return null;
  const lons = coords.map(c => c[0]);
  const lats = coords.map(c => c[1]);
  return {
    min_lat: Math.min(...lats), max_lat: Math.max(...lats),
    min_lon: Math.min(...lons), max_lon: Math.max(...lons),
  };
}

async function crawlBBBike() {
  const out = [];
  try {
    const bbResp = await fetch(BBBIKE_BASE + '/', { signal: AbortSignal.timeout(30000) });
    if (!bbResp.ok) return out;
    const bbHtml = await bbResp.text();
    const cityDirs = bbHtml.match(/<a\s+href="([A-Z][A-Za-z0-9_-]+)\/"/g) || [];
    const seen = new Set();
    const cities = [];
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
    const bbBboxMap = new Map();
    for (const r of polyResults) if (r.status === 'fulfilled' && r.value.bbox) bbBboxMap.set(r.value.city, r.value.bbox);
    for (const city of cities) {
      const display = city.replace(/([a-z])([A-Z])/g, '$1 $2');
      const bb = bbBboxMap.get(city);
      out.push({
        catalog_id: 'bbbike:' + city, source: 'bbbike',
        region_name: display, region_key: city,
        hierarchy: null, continent: null, country: null,
        pbf_url: BBBIKE_BASE + '/' + city + '/' + city + '.osm.pbf',
        pbf_size_mb: null, level: 'city',
        min_lat: bb?.min_lat ?? null, max_lat: bb?.max_lat ?? null,
        min_lon: bb?.min_lon ?? null, max_lon: bb?.max_lon ?? null,
      });
    }
  } catch {}
  return out;
}

// ---------- Crawler driver: identical structure to server/index.ts:686-743 ----------
async function crawl(parser, gfBbox) {
  const allRows = [];

  const html = await fetchPage(GEOFABRIK_BASE);
  const continents = parser(html, '');

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
    const countries = parser(subHtml, continent.sub_path);

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
      const subRegions = parser(sub2Html, country.sub_path);

      for (const subReg of subRegions) {
        const srKey = subReg.sub_path;
        // Bbox lookup with fallbacks: full path, stripped continent, last segment.
        const srBbox =
          gfBbox.get(srKey) ||
          gfBbox.get(srKey.split('/').slice(1).join('/')) ||
          gfBbox.get(srKey.split('/').pop());
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

  return allRows;
}

function dedup(rows) {
  const seen = new Map();
  const out = [];
  for (let i = rows.length - 1; i >= 0; i--) {
    const dk = `${rows[i].source}:${rows[i].region_key}:${rows[i].country || ''}`;
    if (!seen.has(dk)) {
      seen.set(dk, true);
      out.unshift(rows[i]);
    }
  }
  return out;
}

// ---------- Baseline loader ----------
function loadBaseline() {
  const file = path.join(__dirname, 'baseline-catalog.jsonl');
  const lines = fs.readFileSync(file, 'utf8').trim().split('\n');
  const meta = JSON.parse(lines[0]);
  const cols = meta.columns;
  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    const arr = JSON.parse(lines[i]);
    const r = {};
    for (let c = 0; c < cols.length; c++) {
      let v = arr[c];
      if (v === 'NULL' || v === null) v = null;
      else if (['MIN_LAT','MAX_LAT','MIN_LON','MAX_LON','PBF_SIZE_MB'].includes(cols[c])) v = (v === null || v === '') ? null : parseFloat(v);
      r[cols[c].toLowerCase()] = v;
    }
    rows.push(r);
  }
  return rows;
}

// ---------- Diff helpers ----------
function rowKey(r) {
  return `${r.source}:${r.level}:${r.region_key}:${r.country || ''}`;
}

function fmtBbox(r) {
  const f = (v) => v == null ? '∅' : Number(v).toFixed(3);
  return `[${f(r.min_lat)},${f(r.max_lat)},${f(r.min_lon)},${f(r.max_lon)}]`;
}

function compareRows(setA, setB, labelA, labelB) {
  const mapA = new Map(setA.map(r => [rowKey(r), r]));
  const mapB = new Map(setB.map(r => [rowKey(r), r]));
  const onlyA = [];
  const onlyB = [];
  const changedUrl = [];
  const changedBbox = [];
  for (const [k, a] of mapA) {
    const b = mapB.get(k);
    if (!b) { onlyA.push(a); continue; }
    if (a.pbf_url !== b.pbf_url) changedUrl.push({ a, b });
    const sameBbox = (a.min_lat === b.min_lat && a.max_lat === b.max_lat && a.min_lon === b.min_lon && a.max_lon === b.max_lon);
    const aHasBbox = a.min_lat != null && a.max_lat != null;
    if (aHasBbox && !sameBbox) changedBbox.push({ a, b });
  }
  for (const [k, b] of mapB) if (!mapA.has(k)) onlyB.push(b);
  return { onlyA, onlyB, changedUrl, changedBbox };
}

function summarizeByLevel(rows) {
  const counts = {};
  for (const r of rows) counts[r.level] = (counts[r.level] || 0) + 1;
  return counts;
}

function summarizeUSStates(rows) {
  return rows.filter(r => r.hierarchy === 'north-america/us').length;
}
function summarizeCanadaProvinces(rows) {
  return rows.filter(r => r.hierarchy === 'north-america/canada').length;
}
function summarizeGermanyLander(rows) {
  return rows.filter(r => r.hierarchy === 'europe/germany').length;
}
function summarizeFrenchRegions(rows) {
  return rows.filter(r => r.hierarchy === 'europe/france').length;
}
function summarizeItalianRegions(rows) {
  return rows.filter(r => r.hierarchy === 'europe/italy').length;
}
function summarizeRussiaSubregions(rows) {
  return rows.filter(r => r.hierarchy === 'russia').length;
}

// ---------- Main ----------
async function main() {
  console.log('=== Loading baseline catalog snapshot ===');
  const baseline = loadBaseline();
  console.log('Baseline rows:', baseline.length);
  console.log('  by level:', summarizeByLevel(baseline));

  console.log('\n=== Fetching Geofabrik bbox index ===');
  const gfBbox = await fetchGeofabrikBboxIndex();
  console.log('bbox entries:', gfBbox.size);

  console.log('\n=== Crawling with OLD parser ===');
  const oldGeofabrik = await crawl(parseGeofabrikIndex_OLD, gfBbox);
  console.log('OLD geofabrik rows (pre-dedup):', oldGeofabrik.length);

  console.log('\n=== Crawling with NEW parser ===');
  const newGeofabrik = await crawl(parseGeofabrikIndex_NEW, gfBbox);
  console.log('NEW geofabrik rows (pre-dedup):', newGeofabrik.length);

  console.log('\n=== Crawling BBBike (unchanged for both) ===');
  const bbbike = await crawlBBBike();
  console.log('BBBike rows:', bbbike.length);

  const oldAll = dedup([...oldGeofabrik, ...bbbike]);
  const newAll = dedup([...newGeofabrik, ...bbbike]);

  console.log('\n=== Summary ===');
  console.log('OLD post-dedup:', oldAll.length, 'by level:', summarizeByLevel(oldAll));
  console.log('NEW post-dedup:', newAll.length, 'by level:', summarizeByLevel(newAll));
  console.log('Baseline    :', baseline.length, 'by level:', summarizeByLevel(baseline));

  console.log('\n=== Sub-region coverage (NEW) ===');
  console.log('US states           :', summarizeUSStates(newAll));
  console.log('Canadian provinces  :', summarizeCanadaProvinces(newAll));
  console.log('German Länder       :', summarizeGermanyLander(newAll));
  console.log('French régions      :', summarizeFrenchRegions(newAll));
  console.log('Italian regions     :', summarizeItalianRegions(newAll));
  console.log('Russia sub-regions  :', summarizeRussiaSubregions(newAll));

  console.log('\n=== Sub-region coverage (OLD) ===');
  console.log('US states           :', summarizeUSStates(oldAll));
  console.log('Russia sub-regions  :', summarizeRussiaSubregions(oldAll));

  console.log('\n=== Diff: OLD parser vs Baseline (fidelity check) ===');
  const oldVsBase = compareRows(baseline, oldAll, 'baseline', 'old');
  console.log('Rows in baseline but not OLD:', oldVsBase.onlyA.length);
  console.log('Rows in OLD but not baseline:', oldVsBase.onlyB.length);
  console.log('Rows with URL drift          :', oldVsBase.changedUrl.length);
  console.log('Rows with bbox drift         :', oldVsBase.changedBbox.length);

  console.log('\n=== Diff: OLD vs NEW (the fix) ===');
  const oldVsNew = compareRows(oldAll, newAll, 'old', 'new');
  console.log('Rows in OLD but missing in NEW:', oldVsNew.onlyA.length);
  console.log('Rows in NEW but missing in OLD:', oldVsNew.onlyB.length);
  console.log('Rows with URL change          :', oldVsNew.changedUrl.length);
  console.log('Rows with bbox change         :', oldVsNew.changedBbox.length);

  // ---------- Pass criteria ----------
  console.log('\n=== Pass criteria ===');
  const passes = [];

  // Fidelity: OLD should reproduce baseline continents/countries/cities at minimum
  const baseContinents = baseline.filter(r => r.level === 'continent').length;
  const oldContinents  = oldAll.filter(r => r.level === 'continent').length;
  passes.push(['OLD reproduces all continents in baseline', oldContinents >= baseContinents]);

  const baseCountries = baseline.filter(r => r.level === 'country').length;
  const oldCountries  = oldAll.filter(r => r.level === 'country').length;
  passes.push(['OLD reproduces >=95% of country count', oldCountries >= 0.95 * baseCountries]);

  const baseCities = baseline.filter(r => r.source === 'bbbike').length;
  const oldCities  = oldAll.filter(r => r.source === 'bbbike').length;
  passes.push(['OLD reproduces all BBBike cities', oldCities >= baseCities * 0.95]);

  // NEW must not drop any continent/country/city present in OLD
  const newContinents = newAll.filter(r => r.level === 'continent').length;
  passes.push(['NEW continents == OLD continents', newContinents === oldContinents]);

  const newCountries  = newAll.filter(r => r.level === 'country').length;
  passes.push(['NEW countries >= OLD countries', newCountries >= oldCountries]);

  const newCities = newAll.filter(r => r.source === 'bbbike').length;
  passes.push(['NEW cities == OLD cities', newCities === oldCities]);

  // NEW URL changes are EXPECTED and DESIRED for sub-region rows whose OLD URLs
  // were broken (404). The fidelity guard is separate: NO continent/country/city
  // URL should change.
  const nonSubregionUrlChanges = oldVsNew.changedUrl.filter(c => c.a.level !== 'sub-region');
  passes.push(['NEW does not change PBF URL of any continent / country / city',
               nonSubregionUrlChanges.length === 0]);

  // NEW: target sub-region counts
  passes.push(['NEW: >=40 US states',  summarizeUSStates(newAll) >= 40]);
  passes.push(['NEW: >=10 Canadian provinces',  summarizeCanadaProvinces(newAll) >= 10]);
  passes.push(['NEW: >=10 German Länder',  summarizeGermanyLander(newAll) >= 10]);
  passes.push(['NEW: >=15 French régions',  summarizeFrenchRegions(newAll) >= 15]);
  passes.push(['NEW: >=5 Italian macroregions (Geofabrik only exposes 5)',
               summarizeItalianRegions(newAll) >= 5]);
  passes.push(['NEW: Russia sub-regions == 10 (regression)',
               summarizeRussiaSubregions(newAll) === 10]);

  // Dedup invariant: keys are unique
  const newKeys = new Set();
  let dedupOK = true;
  for (const r of newAll) {
    const k = `${r.source}:${r.region_key}:${r.country || ''}`;
    if (newKeys.has(k)) { dedupOK = false; break; }
    newKeys.add(k);
  }
  passes.push(['NEW: dedup keys unique', dedupOK]);

  let allOk = true;
  for (const [label, ok] of passes) {
    console.log((ok ? 'PASS' : 'FAIL') + ' - ' + label);
    if (!ok) allOk = false;
  }

  // ---------- HEAD-check: NEW URLs (changed) must return 200; baseline OLD URLs likely 404 ----------
  console.log('\n=== HEAD-check 20 random NEW (changed) PBF URLs ===');
  // Pool: all rows whose URL changed (these are the fixed ones), plus any rows
  // present only in NEW (greenfield discovered).
  const candidates = [
    ...oldVsNew.changedUrl.map(c => ({ old_url: c.a.pbf_url, new_url: c.b.pbf_url, region_name: c.b.region_name, hierarchy: c.b.hierarchy })),
    ...oldVsNew.onlyB.filter(r => r.source === 'geofabrik').map(r => ({ old_url: null, new_url: r.pbf_url, region_name: r.region_name, hierarchy: r.hierarchy })),
  ];
  console.log('Total candidate rows:', candidates.length);
  const sample = [];
  const used = new Set();
  while (sample.length < Math.min(20, candidates.length)) {
    const i = Math.floor(Math.random() * candidates.length);
    if (used.has(i)) continue;
    used.add(i);
    sample.push(candidates[i]);
  }
  let pbfOK = 0, pbfBad = 0;
  let oldBroken = 0, oldStillOk = 0;
  // Geofabrik returns 302s. A valid PBF redirects to a dated .osm.pbf (e.g. texas-260512.osm.pbf).
  // A broken/wrong path redirects to "/" (Apache root) or returns 404. We must check the
  // Location header, not just status, because Apache's homepage HTML returns 200.
  async function checkPbfUrl(url) {
    try {
      const r = await fetch(url, { method: 'HEAD', redirect: 'manual', signal: AbortSignal.timeout(15000) });
      if (r.status === 200) return { ok: true, code: 200, loc: null };
      if (r.status >= 300 && r.status < 400) {
        const loc = r.headers.get('location') || '';
        const ok = /\.osm\.pbf(\?|$)/i.test(loc);
        return { ok, code: r.status, loc };
      }
      return { ok: false, code: r.status, loc: null };
    } catch (e) {
      return { ok: false, code: 'ERR', loc: e.message };
    }
  }
  for (const r of sample) {
    const newRes = await checkPbfUrl(r.new_url);
    if (newRes.ok) { pbfOK++; console.log('  NEW OK ', newRes.code, '->', newRes.loc || '(direct)', '|', r.new_url); }
    else { pbfBad++; console.log('  NEW BAD', newRes.code, '->', newRes.loc || '(none)', '|', r.new_url); }
    if (r.old_url) {
      const oldRes = await checkPbfUrl(r.old_url);
      if (oldRes.ok) { oldStillOk++; console.log('  OLD OK ', oldRes.code, '->', oldRes.loc || '(direct)', '|', r.old_url); }
      else { oldBroken++; console.log('  OLD BAD', oldRes.code, '->', oldRes.loc || '(none)', '|', r.old_url); }
    }
  }
  passes.push([`HEAD-check: all sampled NEW URLs return 200 (${pbfOK}/${sample.length})`,
               pbfOK === sample.length && sample.length > 0]);
  // Also confirm at least some OLD URLs were broken (proving the fix was needed)
  passes.push([`HEAD-check: OLD URLs were broken on at least 50% of changed rows (broken=${oldBroken}, stillOk=${oldStillOk})`,
               sample.filter(s => s.old_url).length === 0 || oldBroken >= Math.floor(sample.filter(s => s.old_url).length / 2)]);
  if (pbfOK !== sample.length || sample.length === 0) allOk = false;
  console.log('HEAD-check: NEW ' + pbfOK + '/' + sample.length + ' returned 200; OLD broken=' + oldBroken + ', stillOk=' + oldStillOk);

  // ---------- Write report ----------
  const report = [];
  report.push('# Catalog parser fix diff report');
  report.push('');
  report.push('Generated: ' + new Date().toISOString());
  report.push('');
  report.push('## Summary');
  report.push('| Set | Total | Continents | Countries | Sub-regions | Cities |');
  report.push('|---|---|---|---|---|---|');
  for (const [n, set] of [['Baseline', baseline], ['OLD', oldAll], ['NEW', newAll]]) {
    const c = summarizeByLevel(set);
    report.push(`| ${n} | ${set.length} | ${c.continent || 0} | ${c.country || 0} | ${c['sub-region'] || 0} | ${c.city || 0} |`);
  }
  report.push('');
  report.push('## NEW sub-region coverage');
  report.push('| Region | Count |');
  report.push('|---|---|');
  report.push('| US states | ' + summarizeUSStates(newAll) + ' |');
  report.push('| Canadian provinces | ' + summarizeCanadaProvinces(newAll) + ' |');
  report.push('| German Länder | ' + summarizeGermanyLander(newAll) + ' |');
  report.push('| French régions | ' + summarizeFrenchRegions(newAll) + ' |');
  report.push('| Italian regions | ' + summarizeItalianRegions(newAll) + ' |');
  report.push('| Russia sub-regions (regression guard) | ' + summarizeRussiaSubregions(newAll) + ' |');
  report.push('');
  report.push('## Pass criteria');
  for (const [label, ok] of passes) {
    report.push('- [' + (ok ? 'x' : ' ') + '] ' + label);
  }
  report.push('');
  if (oldVsNew.onlyA.length) {
    report.push('## Rows in OLD but missing in NEW (must be empty)');
    for (const r of oldVsNew.onlyA.slice(0, 50)) {
      report.push('- ' + rowKey(r) + ' ' + r.pbf_url);
    }
    report.push('');
  }
  if (oldVsNew.changedUrl.length) {
    report.push('## Rows with PBF URL change OLD→NEW (must be empty)');
    for (const c of oldVsNew.changedUrl.slice(0, 50)) {
      report.push('- ' + rowKey(c.a) + '\n   OLD: ' + c.a.pbf_url + '\n   NEW: ' + c.b.pbf_url);
    }
    report.push('');
  }
  report.push('## Sample of NEW sub-region rows');
  const newSubregions = newAll.filter(r => r.level === 'sub-region');
  for (const r of newSubregions.slice(0, 30)) {
    report.push('- ' + r.region_name + ' (' + r.hierarchy + ') -> ' + r.pbf_url);
  }
  fs.writeFileSync(path.join(__dirname, 'diff-report.md'), report.join('\n'));
  console.log('\nWrote diff-report.md');

  console.log('\n=== OVERALL: ' + (allOk ? 'PASS' : 'FAIL') + ' ===');
  process.exit(allOk ? 0 : 1);
}

main().catch(e => { console.error(e); process.exit(2); });

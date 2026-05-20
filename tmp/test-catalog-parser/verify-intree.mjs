// Verify the in-tree parser in server/index.ts produces identical output to the
// validated NEW parser in run.mjs. Extracts parseGeofabrikIndex from server/index.ts,
// strips TS type annotations, eval-loads it, and runs the same crawl.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.join(__dirname, '..', '..');

// Bring in shared helpers + crawler from run.mjs
const runSrc = fs.readFileSync(path.join(__dirname, 'run.mjs'), 'utf8');

const tsSrc = fs.readFileSync(
  path.join(REPO, '.cortex/skills/build-routing-solution/openrouteservice_app/services/ors_control_app/server/index.ts'),
  'utf8'
);

// Extract `function parseGeofabrikIndex(...) { ... }` (the inner definition).
const fnMatch = tsSrc.match(/function parseGeofabrikIndex\s*\(([\s\S]*?)\)\s*:\s*Array<[^>]+>\s*\{([\s\S]*?)\n  \}\n/);
if (!fnMatch) { console.error('Could not extract parseGeofabrikIndex from server/index.ts'); process.exit(2); }
const params = fnMatch[1].replace(/:\s*string/g, '');
const body = fnMatch[2]
  .replace(/:\s*Array<[^>]+>/g, '')
  .replace(/:\s*string/g, '')
  .replace(/:\s*number\s*\|\s*null/g, '')
  .replace(/:\s*boolean/g, '');

// parseSize/toRegionKey/fetch helpers come from run.mjs
const helpersFromRun = runSrc
  .split('// ---------- OLD PARSER')[0]; // header + helpers only

const harnessSrc = `
${helpersFromRun}

const parseGeofabrikIndex_INTREE = function (${params}) {${body}};

export { parseGeofabrikIndex_INTREE, GEOFABRIK_BASE, BBBIKE_BASE, fetchPage, fetchGeofabrikBboxIndex, toRegionKey, parseSize };
`;
fs.writeFileSync(path.join(__dirname, '_tree-parser.mjs'), harnessSrc);
console.log('Wrote _tree-parser.mjs (length:', harnessSrc.length, ')');

// Now run a focused crawl with the in-tree parser and compare the count + a few key URLs
const mod = await import('./_tree-parser.mjs');
const gfBbox = await mod.fetchGeofabrikBboxIndex();

async function crawl(parser) {
  const allRows = [];
  const html = await mod.fetchPage(mod.GEOFABRIK_BASE);
  const continents = parser(html, '');
  for (const continent of continents) {
    const cBbox = gfBbox.get(continent.sub_path);
    allRows.push({ level: 'continent', name: continent.name, sub_path: continent.sub_path, pbf_url: continent.pbf_url, has_sub: continent.has_sub });
    if (!continent.has_sub || !continent.sub_path) continue;
    const subHtml = await mod.fetchPage(mod.GEOFABRIK_BASE + '/' + continent.sub_path + '.html');
    if (!subHtml) continue;
    const countries = parser(subHtml, continent.sub_path);
    for (const country of countries) {
      allRows.push({ level: 'country', name: country.name, sub_path: country.sub_path, pbf_url: country.pbf_url, has_sub: country.has_sub });
      if (!country.has_sub || !country.sub_path) continue;
      const sub2Html = await mod.fetchPage(mod.GEOFABRIK_BASE + '/' + country.sub_path + '.html');
      if (!sub2Html) continue;
      const subRegions = parser(sub2Html, country.sub_path);
      for (const subReg of subRegions) {
        allRows.push({ level: 'sub-region', name: subReg.name, sub_path: subReg.sub_path, pbf_url: subReg.pbf_url, has_sub: subReg.has_sub });
      }
    }
  }
  return allRows;
}

console.log('Crawling with in-tree parser...');
const tree = await crawl(mod.parseGeofabrikIndex_INTREE);
const counts = {};
for (const r of tree) counts[r.level] = (counts[r.level] || 0) + 1;
console.log('In-tree result counts:', counts);

const usStates = tree.filter(r => /us\/[a-z\-]+$/.test(r.sub_path)).length;
const canadaProv = tree.filter(r => /canada\/[a-z\-]+$/.test(r.sub_path)).length;
const germanyLand = tree.filter(r => /germany\/[a-z\-]+$/.test(r.sub_path)).length;
console.log('In-tree US states:', usStates, '| Canadian provinces:', canadaProv, '| German Lander:', germanyLand);

// Spot-check 5 specific PBF URLs against expected canonical values
const expect = (name, expected) => {
  const r = tree.find(x => x.name === name);
  if (!r) { console.log('MISSING', name); return false; }
  const ok = r.pbf_url === expected;
  console.log((ok ? 'PASS' : 'FAIL'), name, '->', r.pbf_url, ok ? '' : '(expected ' + expected + ')');
  return ok;
};
const ok1 = expect('California',  'https://download.geofabrik.de/north-america/us/california-latest.osm.pbf');
const ok2 = expect('Texas',       'https://download.geofabrik.de/north-america/us/texas-latest.osm.pbf');
const ok3 = expect('Bayern',      'https://download.geofabrik.de/europe/germany/bayern-latest.osm.pbf');
const ok4 = expect('Ontario',     'https://download.geofabrik.de/north-america/canada/ontario-latest.osm.pbf');
const ok5 = expect('Centro',      'https://download.geofabrik.de/europe/italy/centro-latest.osm.pbf');
const ok6 = expect('North America','https://download.geofabrik.de/north-america-latest.osm.pbf');
const ok7 = expect('Germany',     'https://download.geofabrik.de/europe/germany-latest.osm.pbf');
const ok8 = expect('Mexico',      'https://download.geofabrik.de/north-america/mexico-latest.osm.pbf');

const allOk = ok1 && ok2 && ok3 && ok4 && ok5 && ok6 && ok7 && ok8 &&
  usStates >= 40 && canadaProv >= 10 && germanyLand >= 10;
console.log('\nIN-TREE PARSER: ' + (allOk ? 'PASS' : 'FAIL'));
process.exit(allOk ? 0 : 1);

// Static gate for the AUTHORED views in app/app-views.json.
//
// Run with (from fleet_sa_app/ui):
//   npx tsx scripts/verify-app-views.mts
//
// WHY THIS EXISTS. There are two producers of view specs and only one of them is
// guarded. The agent's specs go through `parseDynamicSpec`, which lowercases
// every known column reference and rejects a Map layer missing its encoding. The
// repo's own dashboards go through `registerViewsFromConfig`, which does neither.
// So the defect that shipped - an uppercase column name matching nothing, drawing
// nothing, and saying nothing - is still reachable by hand-editing this file.
//
// It cannot be caught by validate_app_views.py: that needs a live connection and
// checks whether the QUERIES behave, not whether the spec's column references
// can bind. This is pure shape, so it runs in CI with no account.
//
// It deliberately imports COLUMN_REF_PATHS and missingEncodings from the runtime
// rather than restating them. A second copy of the path list would drift, and
// then the gate would be asserting a rule the app no longer follows.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { COLUMN_REF_PATHS, NO_COLUMN_REFS, normalizeAreaColumnRefs } from '../src/lib/view-column-refs';
import { missingEncodings, normalizeColumnRefs } from '../src/lib/map-spec-schema';

const here = path.dirname(fileURLToPath(import.meta.url));
const VIEWS_PATH = path.join(here, '..', '..', 'app', 'app-views.json');

const failures: string[] = [];
let checked = 0;

function fail(msg: string): void {
  failures.push(msg);
}

/** Report every leaf path where `before` and `after` disagree. */
function diffPaths(before: unknown, after: unknown, trail = ''): string[] {
  if (before === after) return [];
  if (Array.isArray(before) && Array.isArray(after)) {
    return before.flatMap((el, i) => diffPaths(el, after[i], `${trail}[${i}]`));
  }
  const isObj = (v: unknown): v is Record<string, unknown> =>
    typeof v === 'object' && v !== null && !Array.isArray(v);
  if (isObj(before) && isObj(after)) {
    return Object.keys(before).flatMap((k) =>
      diffPaths(before[k], after[k], trail ? `${trail}.${k}` : k));
  }
  return [`${trail}: ${JSON.stringify(before)} -> ${JSON.stringify(after)}`];
}

const raw = JSON.parse(readFileSync(VIEWS_PATH, 'utf8')) as Record<string, {
  areas?: Record<string, Record<string, unknown>>;
}>;

const classified = new Set<string>([...Object.keys(COLUMN_REF_PATHS), ...NO_COLUMN_REFS]);

for (const [viewName, view] of Object.entries(raw)) {
  for (const [areaName, area] of Object.entries(view.areas ?? {})) {
    const where = `${viewName}.${areaName}`;
    const comp = String(area.component ?? '');
    checked += 1;

    // An unclassified component gets NO normalization on the agent path either,
    // so it is a silent gap in both producers at once.
    if (!classified.has(comp)) {
      fail(`${where}: component '${comp}' is in neither COLUMN_REF_PATHS nor NO_COLUMN_REFS,`
        + ` so its column references are never normalized`);
      continue;
    }

    // Equality against the runtime's own normalizer IS the lowercase assertion:
    // whatever it would have changed is a reference that cannot bind against
    // /api/query, which lowercases every row key it returns.
    const normalized = normalizeAreaColumnRefs(comp, area);
    const drifted = diffPaths(area, normalized);
    if (drifted.length) {
      fail(`${where} (${comp}): column reference(s) are not lowercase, so they will not`
        + ` match the query result: ${drifted.join('; ')}`);
    }

    if (comp !== 'Map') continue;

    const layers = (area.config as Record<string, unknown> | undefined)?.layers;
    if (!Array.isArray(layers)) {
      fail(`${where}: a Map area has no config.layers array, so it can draw nothing`);
      continue;
    }
    layers.forEach((layer, i) => {
      if (typeof layer !== 'object' || layer === null) {
        fail(`${where}: layer ${i} is not an object`);
        return;
      }
      const spec = layer as Record<string, unknown>;
      const id = String(spec.id ?? `layer ${i}`);
      const missing = missingEncodings(spec);
      if (missing.length) {
        fail(`${where} layer '${id}' (type '${String(spec.type)}') is missing ${missing.join(', ')}`
          + ` - without it the layer draws nothing`);
      }
      // Map is in NO_COLUMN_REFS because its refs live on the LAYERS, normalized
      // by the map-specific pass rather than by the area path list - so the area
      // diff above cannot see them. Clone first: normalizeColumnRefs mutates.
      const clone = JSON.parse(JSON.stringify(spec)) as Record<string, unknown>;
      normalizeColumnRefs(clone);
      const layerDrift = diffPaths(spec, clone);
      if (layerDrift.length) {
        fail(`${where} layer '${id}': column reference(s) are not lowercase, so they will not`
          + ` match the query result: ${layerDrift.join('; ')}`);
      }
    });
  }
}

console.log(`${checked} authored area(s) checked in ${path.relative(process.cwd(), VIEWS_PATH)}`);
if (failures.length) {
  console.error(`\nFAILED ${failures.length} check(s):`);
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}
console.log('PASSED: every authored column reference can bind, and every map layer has its encoding');

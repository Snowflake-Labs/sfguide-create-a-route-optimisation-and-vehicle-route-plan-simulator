// Prints {schemas: {viewId: [schemas]}, probes: {schema: [object, isFunction]}} for app-views.json using lib/view-deps.ts, so
// scripts/check_view_availability.py can assert the app's dependency walk
// matches layer_impact.py's. Run from fleet_sa_app/ui:
//   npx tsx scripts/print-view-schemas.mts
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { schemaProbes, viewSchemas } from '../src/lib/view-deps';

const here = path.dirname(fileURLToPath(import.meta.url));
const views = JSON.parse(readFileSync(path.join(here, '../../app/app-views.json'), 'utf-8')) as Record<string, unknown>;
const out: Record<string, string[]> = {};
for (const [id, v] of Object.entries(views)) out[id] = [...viewSchemas(v, 'FLEET_APP')].sort();
// schema -> probe object, as /api/pack-status chooses it.
const probes = Object.fromEntries(
  Object.entries(schemaProbes(views, 'FLEET_APP')).map(([s, r]) => [s, [r.object, r.isFunction]]),
);
console.log(JSON.stringify({ schemas: out, probes }));

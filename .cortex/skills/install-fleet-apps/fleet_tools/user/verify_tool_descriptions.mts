// Fails when a verb's MCP tool description exceeds what Snowflake will accept.
//
// Run with (from fleet_tools/user):
//   npx tsx verify_tool_descriptions.mts
//
// WHY THIS IS A GATE AND NOT A CODE REVIEW NOTE
// --------------------------------------------
// The limit is 2500 characters per tool description, and it is enforced in
// exactly one place: `CREATE MCP SERVER`, at install time, with
//
//   Cannot create MCP server because spec is invalid:
//   java.lang.IllegalArgumentException: Tool Definition: description length
//   exceeds maximum of 2500 characters
//
// That error NAMES NO TOOL. It fails the WHOLE bundle, so every verb in the
// server disappears at once, and the failing spec is echoed into the install log
// truncated. Measured cost the first time: ~440 characters added to `render_map`
// broke the entire user bundle install, and finding which of 25 tools was over
// meant measuring by hand.
//
// `render_map` currently sits within ~20 characters of the cap, so the next
// sentence anyone adds - to any verb - is a coin flip between "works" and "the
// consumer agent has no tools". Hence a local, offline check with headroom.
//
// WHY IT IMPORTS THE PROCS INSTEAD OF PARSING THEM
// ------------------------------------------------
// A description is built by concatenating string literals and interpolating
// constants (MAX_MAP_LAYERS, MAP_LAYER_TYPES, ALLOWED_DYNAMIC_DBS). A regex over
// the source has to re-implement that concatenation and gets the interpolated
// lengths wrong, which is how a "measurement" ends up off by tens of characters
// right at the boundary. Importing yields the exact string Snowflake will see.
import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

/** Snowflake's hard cap, per tool, enforced at CREATE MCP SERVER. */
const HARD_LIMIT = 2500;
/** Fail below the cap: a description that fits today but has no room is a trap
 *  for the next edit, and the failure mode is the whole bundle. */
const BUDGET = 2400;

const here = dirname(fileURLToPath(import.meta.url));
// Bundles that materialize an MCP server. All three are checked: the cap applies
// per tool definition, not per server, so an ops verb can break its own bundle.
const BUNDLES = ['user', 'ops', 'admin'].map((b) => ({
  name: b,
  dir: join(here, '..', b, 'src', 'procs'),
}));

let fails = 0;
let checked = 0;
const rows: Array<{ bundle: string; name: string; len: number }> = [];

for (const bundle of BUNDLES) {
  let files: string[];
  try {
    files = readdirSync(bundle.dir).filter((f) => f.endsWith('.ts'));
  } catch {
    console.log(`  SKIP  ${bundle.name}: no procs directory at ${bundle.dir}`);
    continue;
  }
  for (const file of files) {
    const mod = (await import(join(bundle.dir, file))) as Record<string, unknown>;
    for (const [exportName, value] of Object.entries(mod)) {
      if (typeof value !== 'object' || value === null) continue;
      const proc = value as { name?: unknown; description?: unknown };
      if (typeof proc.name !== 'string' || typeof proc.description !== 'string') continue;
      checked++;
      const len = proc.description.length;
      rows.push({ bundle: bundle.name, name: proc.name, len });
      if (len > BUDGET) {
        fails++;
        const over = len > HARD_LIMIT;
        console.log(
          `  ${over ? 'FAIL ' : 'FAIL '} ${bundle.name}/${proc.name} (${exportName}): ` +
          `${len} chars ${over
            ? `EXCEEDS the hard limit of ${HARD_LIMIT} - CREATE MCP SERVER will reject the whole bundle`
            : `is over the ${BUDGET} budget (hard limit ${HARD_LIMIT}); trim before adding more`}`,
        );
      }
    }
  }
}

rows.sort((a, b) => b.len - a.len);
console.log('\nMCP tool description lengths (longest first, top 8):');
for (const r of rows.slice(0, 8)) {
  const pct = Math.round((r.len / HARD_LIMIT) * 100);
  console.log(`  ${String(r.len).padStart(5)}  ${String(pct).padStart(3)}%  ${r.bundle}/${r.name}`);
}
console.log(`\n  tools checked ${checked}   budget ${BUDGET}   hard limit ${HARD_LIMIT}`);

if (fails > 0) {
  console.log(`\n${fails} tool description(s) over budget`);
  process.exit(1);
}
console.log('\nPASSED: every tool description fits with headroom');

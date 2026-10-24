// Shared local connection for the probe_cowork_rows*.mts live probes.
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';

type Obj = Record<string, unknown>;

// snowflake-sdk 3.x is CJS-only for createConnection (see vendor/synapse VENDOR.md, patch 09).
const sdk = createRequire(import.meta.url)('./node_modules/@snowflake/synapse/node_modules/snowflake-sdk');

// The SDK only auto-loads ~/.snowflake/connections.toml; this machine keeps
// connections in config.toml, so read the one [connections.<name>] block here.
function tomlBlock(name: string): Obj {
  const text = readFileSync(`${homedir()}/.snowflake/config.toml`, 'utf8');
  const out: Obj = {};
  let on = false;
  for (const line of text.split('\n')) {
    const h = line.match(/^\s*\[(.+)\]\s*$/);
    if (h) { on = h[1] === `connections.${name}`; continue; }
    const kv = on && line.match(/^\s*([A-Za-z_]+)\s*=\s*"?(.*?)"?\s*$/);
    if (kv) out[kv[1]!] = kv[2];
  }
  if (!out.account) throw new Error(`no [connections.${name}] in config.toml`);
  return out;
}

export async function connect(name: string) {
  const t = tomlBlock(name);
  const c = sdk.createConnection({
    account: t.account, username: t.user, password: t.password, token: t.token,
    authenticator: t.authenticator, role: t.role, warehouse: t.warehouse,
  });
  await new Promise((ok, no) => c.connectAsync((e: Error | null) => (e ? no(e) : ok(null))));
  const exec = (sqlText: string, binds: unknown[] = []) =>
    new Promise<Obj[]>((ok, no) =>
      c.execute({ sqlText, binds, complete: (e: Error | null, _s: unknown, rows: Obj[]) => (e ? no(e) : ok(rows ?? [])) }));
  return {
    exec,
    execRow: async (s: string, b?: unknown[]) => (await exec(s, b))[0] ?? null,
    execScalar: async (s: string, b?: unknown[]) => { const r = (await exec(s, b))[0]; return r ? Object.values(r)[0] : null; },
    close: () => c.destroy(() => {}),
  };
}

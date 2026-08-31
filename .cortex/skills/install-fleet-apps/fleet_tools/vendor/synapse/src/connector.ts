import * as snowflake from 'snowflake-sdk';
import type { Binds } from 'snowflake-sdk';

export interface ConnConfig {
  account: string;
  username: string;
  password?: string;
  authenticator?: string;
  token?: string;
  role?: string;
  warehouse?: string;
  database?: string;
  schema?: string;
}

export interface Conn {
  /**
   * Run a statement, return rows as objects keyed by column name.
   *
   * Return type is `Promise<R[]> | R[]` so the same `Conn` interface works for both
   * the local (async, snowflake-sdk) and sproc (sync, `snowflake.execute`) targets.
   * `await` is a no-op on non-Promise values, so callers always write
   * `await conn.exec(...)` regardless of target.
   */
  exec<R = Record<string, unknown>>(sqlText: string, binds?: unknown[]): Promise<R[]> | R[];
  /** Run a statement, return the first row or null. */
  execRow<R = Record<string, unknown>>(sqlText: string, binds?: unknown[]): Promise<R | null> | R | null;
  /** Run a statement, return the first column of the first row or null. */
  execScalar<T = unknown>(sqlText: string, binds?: unknown[]): Promise<T | null> | T | null;
  /** Close the connection. */
  close(): Promise<void> | void;
}

/**
 * Snowflake passes JS `undefined` through as a bind error, rejects boolean
 * binds outright ("Unsupported type for binding argument"), and Date objects
 * can't be bound directly. Normalize at every bind site so callers never see
 * any of these.
 */
function normalizeBinds(binds: unknown[] | undefined): Binds {
  if (!binds || binds.length === 0) return [] as unknown as Binds;
  return binds.map(v => {
    if (v === undefined) return null;
    if (v === true) return 1;
    if (v === false) return 0;
    if (v instanceof Date) return v.toISOString();
    return v;
  }) as unknown as Binds;
}

/**
 * Coerce snowflake-sdk's "rich" column representations into JS primitives
 * the verb schemas expect.
 *
 * - TIMESTAMP_TZ: snowflake-sdk yields `{epoch, fraction, timezone}` objects
 *   (epoch in seconds, fraction in ns). Lift to ISO 8601 string.
 * - Date: TIMESTAMP_NTZ / DATE come back as native Date. Lift to ISO string.
 *
 * Verbs declare timestamp-typed return fields as `t.string()` and the
 * schema validator would reject the rich object form; this is the single
 * place that conversion happens.
 */
function coerceCell(v: unknown): unknown {
  if (v === null || v === undefined) return v;
  if (v instanceof Date) return v.toISOString();
  if (typeof v === 'object') {
    const o = v as { epoch?: unknown; fraction?: unknown; timezone?: unknown };
    if (typeof o.epoch === 'number' && typeof o.fraction === 'number') {
      // epoch is seconds; fraction is nanoseconds within the second.
      const ms = o.epoch * 1000 + Math.floor(o.fraction / 1e6);
      return new Date(ms).toISOString();
    }
  }
  return v;
}

function coerceRow(row: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(row)) out[k] = coerceCell(row[k]);
  return out;
}

function executeStatement(
  conn: snowflake.Connection,
  sqlText: string,
  binds: unknown[] | undefined,
): Promise<Record<string, unknown>[]> {
  return new Promise((resolve, reject) => {
    conn.execute({
      sqlText,
      binds: normalizeBinds(binds),
      complete: (err, _stmt, rows) => {
        if (err) return reject(err);
        resolve(((rows ?? []) as Record<string, unknown>[]).map(coerceRow));
      },
    });
  });
}

export async function createConn(cfg: ConnConfig): Promise<Conn> {
  const opts: snowflake.ConnectionOptions = {
    account:  cfg.account,
    username: cfg.username,
    ...(cfg.password      !== undefined ? { password: cfg.password } : {}),
    ...(cfg.authenticator !== undefined ? { authenticator: cfg.authenticator } : {}),
    ...(cfg.token         !== undefined ? { token: cfg.token } : {}),
    ...(cfg.role          !== undefined ? { role: cfg.role } : {}),
    ...(cfg.warehouse     !== undefined ? { warehouse: cfg.warehouse } : {}),
    ...(cfg.database      !== undefined ? { database: cfg.database } : {}),
    ...(cfg.schema        !== undefined ? { schema: cfg.schema } : {}),
  };

  return connectAndWrap(opts, cfg.authenticator);
}

/**
 * Connect using an entry from `~/.snowflake/connections.toml`. The
 * snowflake-sdk reads the file natively when `createConnection()` is
 * called with no options; we point it at the right entry by setting
 * `SNOWFLAKE_DEFAULT_CONNECTION_NAME` first.
 *
 * `overrides` lets callers override database / schema / warehouse / role
 * after the toml entry is resolved (one connection often hosts many
 * deploy targets). authenticator/token/account/user always come from
 * the toml entry.
 */
export async function createConnFromCli(
  connectionName: string,
  overrides: Pick<ConnConfig, 'role' | 'warehouse' | 'database' | 'schema'> = {},
): Promise<Conn> {
  process.env.SNOWFLAKE_DEFAULT_CONNECTION_NAME = connectionName;

  // The sdk only reads connections.toml when `createConnection` is called
  // with NO options object (null/undefined). Passing `{}` triggers the
  // username-required validation. So we connect from the toml entry first,
  // then apply overrides via USE statements after the session is open.
  const sfConn = (snowflake.createConnection as unknown as () => snowflake.Connection)();
  await new Promise<void>((resolve, reject) => {
    sfConn.connect(err => err ? reject(err) : resolve());
  });

  // Apply install-target overrides. Issued in the canonical order so a
  // role-change doesn't lose access to the warehouse/db/schema we want.
  const useStmts: string[] = [];
  if (overrides.role)      useStmts.push(`USE ROLE ${overrides.role}`);
  if (overrides.warehouse) useStmts.push(`USE WAREHOUSE ${overrides.warehouse}`);
  if (overrides.database)  useStmts.push(`USE DATABASE ${overrides.database}`);
  if (overrides.schema)    useStmts.push(`USE SCHEMA ${overrides.schema}`);
  for (const stmt of useStmts) {
    await new Promise<void>((resolve, reject) => {
      sfConn.execute({
        sqlText: stmt,
        complete: err => err ? reject(err) : resolve(),
      });
    });
  }

  return wrapSfConn(sfConn);
}

function wrapSfConn(sfConn: snowflake.Connection): Conn {
  return {
    exec: async <R = Record<string, unknown>>(sqlText: string, binds?: unknown[]) => {
      const rows = await executeStatement(sfConn, sqlText, binds);
      return rows as unknown as R[];
    },
    execRow: async <R = Record<string, unknown>>(sqlText: string, binds?: unknown[]) => {
      const rows = await executeStatement(sfConn, sqlText, binds);
      if (rows.length === 0) return null;
      return rows[0] as unknown as R;
    },
    execScalar: async <T = unknown>(sqlText: string, binds?: unknown[]) => {
      const rows = await executeStatement(sfConn, sqlText, binds);
      if (rows.length === 0) return null;
      const first = rows[0]!;
      const keys = Object.keys(first);
      if (keys.length === 0) return null;
      return first[keys[0]!] as unknown as T;
    },
    close: () => new Promise<void>((resolve, reject) => {
      sfConn.destroy(err => {
        if (err) reject(err);
        else resolve();
      });
    }),
  };
}

async function connectAndWrap(
  opts: snowflake.ConnectionOptions,
  authenticator: string | undefined,
): Promise<Conn> {
  const sfConn = snowflake.createConnection(opts);
  await new Promise<void>((resolve, reject) => {
    const useBrowser = authenticator !== undefined &&
      authenticator.toUpperCase() === 'EXTERNALBROWSER';
    const cb = (err: snowflake.SnowflakeError | undefined) => {
      if (err) reject(err);
      else resolve();
    };
    if (useBrowser) {
      sfConn.connectAsync(cb);
    } else {
      sfConn.connect(cb);
    }
  });
  return wrapSfConn(sfConn);
}

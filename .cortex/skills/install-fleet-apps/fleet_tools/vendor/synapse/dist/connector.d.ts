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
export declare function createConn(cfg: ConnConfig): Promise<Conn>;
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
export declare function createConnFromCli(connectionName: string, overrides?: Pick<ConnConfig, 'role' | 'warehouse' | 'database' | 'schema'>): Promise<Conn>;
//# sourceMappingURL=connector.d.ts.map
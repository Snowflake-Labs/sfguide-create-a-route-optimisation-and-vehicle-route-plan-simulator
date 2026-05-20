# Snowflake SQL Gotchas

Subtle Snowflake-specific rules that have cost real time during this skill's
development. Capture them here so the next contributor (human or AI) does not
rediscover them by trial and error.

## SYSTEM$GET_SERVICE_STATUS requires a constant argument

```sql
-- DOES NOT COMPILE
CREATE OR REPLACE FUNCTION GET_PEAK_RSS_GIB(P_REGION VARCHAR)
RETURNS FLOAT
AS $$
  TRY_CAST(TRY_PARSE_JSON(
    SYSTEM$GET_SERVICE_STATUS('DB.SCHEMA.SVC_' || UPPER(P_REGION))
  )[0]:containerStatus:peakMemoryGiB AS FLOAT)
$$;
-- ERROR: argument 1 to function SYSTEM$GET_SERVICE_STATUS needs to be constant
```

`SYSTEM$GET_SERVICE_STATUS('<fqn>')` only accepts a string literal. You cannot
build the FQN from a UDF parameter or any other dynamic expression.

**Workaround:** call it inside a Snowflake Scripting procedure where the FQN
is concatenated at runtime, then capture the result via `RESULT_SCAN`:

```sql
EXECUTE IMMEDIATE 'CALL SYSTEM$GET_SERVICE_STATUS(''' || :svc_full || ''')';
LET rs RESULTSET := (SELECT TRY_CAST(
    TRY_PARSE_JSON(VALUE::VARCHAR)[0]:containerStatus:peakMemoryGiB::VARCHAR AS FLOAT
  ) AS V FROM TABLE(RESULT_SCAN(LAST_QUERY_ID())));
LET c CURSOR FOR rs;
FOR r IN c DO peak_rss := r.V; END FOR;
```

In practice, prefer to **inline this block in the parent procedure** that
already has the region in scope rather than wrapping it in another helper
procedure (calling a procedure-that-returns-scalar from inside another
procedure is awkward in Snowflake Scripting).

See: `PROVISION_REGION_WRAPPER` success path.

## INSERT ... VALUES does not allow function calls

```sql
-- DOES NOT WORK
INSERT INTO MY_TABLE (BUILD_ID, REGION, STARTED_AT)
VALUES (UUID_STRING(), 'USA', CURRENT_TIMESTAMP());
-- ERROR: Invalid expression [UUID_STRING()] in VALUES clause
```

Snowflake refuses any function call inside a VALUES clause.

**Workaround 1** — `INSERT ... SELECT` (functions are valid in SELECT):

```sql
INSERT INTO MY_TABLE (BUILD_ID, REGION, STARTED_AT)
SELECT UUID_STRING(), 'USA', CURRENT_TIMESTAMP();
```

**Workaround 2** — inside a Snowflake Scripting procedure, assign to a `LET`
or `DECLARE` variable first, then reference `:var` in VALUES (variables are
allowed; function calls are not):

```sql
DECLARE
    build_id VARCHAR DEFAULT UUID_STRING();
BEGIN
    INSERT INTO MY_TABLE (BUILD_ID, REGION, STARTED_AT)
    VALUES (:build_id, :P_REGION, CURRENT_TIMESTAMP());
END;
```

This is the pattern used by `PROVISION_REGION_WRAPPER`.

## SHOW ... + RESULT_SCAN columns are quoted lower-case

```sql
-- WRONG: column is "ingress_url", not INGRESS_URL
SHOW ENDPOINTS IN SERVICE OPENROUTESERVICE_APP.CORE.ORS_CONTROL_APP;
SELECT 'https://' || ingress_url
FROM TABLE(RESULT_SCAN(LAST_QUERY_ID()))
WHERE name = 'ors-control-app';
-- ERROR: invalid identifier 'INGRESS_URL'
```

`SHOW ...` produces a result set whose column names are case-sensitive
quoted lowercase identifiers (e.g. `"name"`, `"ingress_url"`, `"status"`).
When you reference them in a wrapping `SELECT FROM TABLE(RESULT_SCAN(...))`,
quote them and keep the lowercase casing exactly as Snowflake emitted it.

```sql
-- CORRECT
SELECT 'https://' || "ingress_url"
FROM TABLE(RESULT_SCAN(LAST_QUERY_ID()))
WHERE "name" = 'ors-control-app';
```

This applies to every `SHOW` statement: `SHOW SERVICES`, `SHOW ENDPOINTS`,
`SHOW COMPUTE POOL INSTANCE FAMILIES`, `SHOW WAREHOUSES`, etc. When in doubt,
run `SHOW ...` interactively first and read the column header casing.

## Helpful tools when these bite

- **Compile-only validation** — when writing SQL you intend to commit but not
  run, compile-check it via `snow sql -q "<ddl>"` against a test connection,
  or via the `snowflake_sql_execute` MCP tool with `only_compile=true`.
- **`snow sql -f <file>`** — applies an entire SQL module. The CLI handles
  `$$ ... $$` procedure bodies correctly without manual splitting.
- **`SHOW COMPUTE POOL INSTANCE FAMILIES`** — the source of truth for which
  families are available in the current cloud + region. Drives the
  `RESOLVE_LARGEST_HIGHMEM_FAMILY` resolver.

---
name: "fix intro spcs access"
created: "2026-03-25T16:29:39.281Z"
status: pending
---

# Fix: Intro Page Not Loading Data on SPCS

## Root Cause

The native app `OPENROUTESERVICE_NATIVE_APP` has **no grants** on the `OPENROUTESERVICE_SETUP` database. The SPCS service runs as the native app, so when the server-side `snowSqlSpcs()` function (line 121 of server/index.ts) calls the Snowflake SQL API with `database: 'OPENROUTESERVICE_SETUP'`, the query fails silently — the error is caught and returned as `{error: ...}` to the frontend, which then falls back to empty arrays.

The grants audit shows:

- `OPENROUTESERVICE_SETUP` has `REFERENCE_USAGE` to the **app package share**, not to the **app itself**
- The app has `USAGE` on `FLEET_INTELLIGENCE` and `SYNTHETIC_DATASETS` databases, but NOT on `OPENROUTESERVICE_SETUP`

The H3 query also needs access because it uses `H3_COVERAGE_STRINGS()` with `OPENROUTESERVICE_SETUP` as the database context.

## Fix

Run three GRANT statements to give the native app access:

```
GRANT USAGE ON DATABASE OPENROUTESERVICE_SETUP TO APPLICATION OPENROUTESERVICE_NATIVE_APP;
GRANT USAGE ON SCHEMA OPENROUTESERVICE_SETUP.PUBLIC TO APPLICATION OPENROUTESERVICE_NATIVE_APP;
GRANT SELECT ON TABLE OPENROUTESERVICE_SETUP.PUBLIC.INTRO_TRIPS TO APPLICATION OPENROUTESERVICE_NATIVE_APP;
```

No code changes or redeployment needed — this is purely a permissions issue.

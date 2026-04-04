# Plan: Fix Deployment + Add Sandbox Testing + SQL Scripting Guidelines

## Root Cause

`ALTER APPLICATION UPGRADE` does NOT re-run the full `setup_script.sql`. It only executes `core.version_init` (the `version_initializer` callback in manifest.yml), which just updates services and calls `create_control_app()` + `create_functions()`. None of our procedure changes (BUILD_MATRIX_JOB_WRAPPER, BUILD_TRAVEL_TIME_RANGE_REGION, etc.) get applied.

## Part 1: Fix the Immediate Bug

**Approach**: Update `core.version_init` to also re-run the matrix-related procedure definitions during upgrade. This way, procedure changes are applied whenever `ALTER APPLICATION UPGRADE` runs.

### Step 1a: Add a `create_matrix_procedures()` helper

Extract the CREATE OR REPLACE PROCEDURE statements for matrix procedures into a new helper procedure called from `version_init`. Alternatively, we can just add the individual CREATE OR REPLACE statements to `version_init` directly.

Simpler approach: just add to `version_init`:
```sql
-- In version_init, after existing calls:
BEGIN
    CALL core.create_matrix_procedures();
EXCEPTION
    WHEN OTHER THEN NULL;
END;
```

And create `core.create_matrix_procedures()` that re-creates all the matrix procedures. However, this is complex since there are many procedures.

**Simplest immediate fix**: Just run the specific CREATE OR REPLACE PROCEDURE statement directly via SQL to hotfix the deployed app, then fix version_init for future upgrades.

### Step 1b: Hotfix the live procedure NOW

Extract the `BUILD_MATRIX_JOB_WRAPPER` procedure definition from [setup_script.sql](.cortex/skills/build-routing-solution/native_app/app/setup_script.sql) (lines 1852-2022) and execute it directly as:

```sql
USE DATABASE OPENROUTESERVICE_NATIVE_APP;
USE SCHEMA CORE;
CREATE OR REPLACE PROCEDURE core.BUILD_MATRIX_JOB_WRAPPER(...)
...
```

This bypasses the upgrade pipeline entirely and patches the running app. We already validated the EXECUTE IMMEDIATE pattern works via the sandbox test procs.

### Step 1c: Fix version_init for future upgrades

Add `version_init` logic to re-create matrix procedures, so future `ALTER APPLICATION UPGRADE` calls will apply procedure changes. This goes into [setup_script.sql](.cortex/skills/build-routing-solution/native_app/app/setup_script.sql) in the `CREATE OR REPLACE PROCEDURE core.VERSION_INIT()` definition.

## Part 2: Sandbox Testing Workflow

Before deploying any SQL Scripting changes, we should validate them by creating a test procedure in `OPENROUTESERVICE_SETUP.PUBLIC` that exercises the exact pattern. This was validated during research:

```sql
-- Sandbox: test variable binding patterns
CREATE OR REPLACE PROCEDURE OPENROUTESERVICE_SETUP.PUBLIC.TEST_PATTERN()
RETURNS VARCHAR LANGUAGE SQL EXECUTE AS CALLER
AS $$
DECLARE
    wait_attempt INTEGER DEFAULT 3;
    wait_secs INTEGER;
BEGIN
    wait_secs := wait_attempt * 15;
    EXECUTE IMMEDIATE 'UPDATE ... SET MESSAGE=''text ' || wait_secs || 's'' WHERE ...';
    RETURN 'OK: ' || wait_secs;
END;
$$;
CALL OPENROUTESERVICE_SETUP.PUBLIC.TEST_PATTERN();
DROP PROCEDURE OPENROUTESERVICE_SETUP.PUBLIC.TEST_PATTERN();
```

This takes seconds vs minutes for the full PUT + UPGRADE cycle.

Add this as a documented pattern in SKILL.md.

## Part 3: SQL Scripting Guidelines in SKILL.md

Append to [SKILL.md](.cortex/skills/build-routing-solution/SKILL.md):

### Variable binding rules

| Context | Syntax | Example |
|---------|--------|---------|
| DML WHERE clause | `:var` required | `WHERE JOB_ID = :P_JOB_ID` |
| DML SET simple scalar | `:var` required | `SET STATUS = :my_var` |
| DML SET with expression/concat | EXECUTE IMMEDIATE | See examples below |
| CALL arguments | `:var` required | `CALL proc(:P_RES)` |
| Variable assignment | No colon | `x := x + 1;` |
| IF/WHILE conditions | No colon | `IF (x > 10) THEN` |
| EXECUTE IMMEDIATE concat | No colon | `'...' \|\| my_var \|\| '...'` |

### Key pitfall

Static UPDATE SET cannot evaluate expressions on local variables:
```sql
-- BROKEN: (wait_attempt * 15) treated as column reference
UPDATE t SET MSG = 'after ' || (wait_attempt * 15) || 's' WHERE ...;

-- FIXED: pre-compute, then use EXECUTE IMMEDIATE
LET wait_secs INTEGER := wait_attempt * 15;
EXECUTE IMMEDIATE 'UPDATE t SET MSG=''after ' || wait_secs || 's'' WHERE ...';
```

### Deployment notes

- `ALTER APPLICATION UPGRADE` only runs `version_init`, not the full setup_script
- To hotfix a live procedure: run CREATE OR REPLACE directly via `USE DATABASE app; USE SCHEMA core;`
- Always sandbox-test new SQL Scripting patterns in `OPENROUTESERVICE_SETUP.PUBLIC` before deploying

### Table schema checklist

When adding columns: update both the CREATE TABLE IF NOT EXISTS DDL and ALTER TABLE the live table.

## Files to Edit

1. [setup_script.sql](.cortex/skills/build-routing-solution/native_app/app/setup_script.sql) — fix version_init to re-create matrix procedures on upgrade
2. [SKILL.md](.cortex/skills/build-routing-solution/SKILL.md) — add SQL Scripting guidelines + sandbox workflow + deployment notes
3. Live hotfix: execute CREATE OR REPLACE PROCEDURE directly against the app

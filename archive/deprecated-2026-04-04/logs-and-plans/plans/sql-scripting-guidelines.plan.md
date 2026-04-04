# Plan: Add Snowflake SQL Scripting Guidelines to SKILL.md

## Problem

The [SKILL.md](.cortex/skills/build-routing-solution/SKILL.md) is purely a deployment playbook with no coding guidelines. The [setup_script.sql](.cortex/skills/build-routing-solution/native_app/app/setup_script.sql) is 2300+ lines with ~30 stored procedures, and we've hit the same class of bug (variable binding) multiple times during this session:

1. `MESSAGE` column missing -- referenced in UPDATE but never added to table DDL
2. `wait_attempt` without `:` prefix inside UPDATE SET clause -- Snowflake Scripting requires colon prefix for variables in DML statements
3. Had to switch to EXECUTE IMMEDIATE with string concatenation because `:var * 15` expressions don't resolve in static SET clauses

## What to Add

A new section **"Snowflake SQL Scripting Guidelines (setup_script.sql)"** appended to the end of SKILL.md, covering:

### 1. Variable Binding Rules (the `:` colon prefix)

| Context | Syntax | Example |
|---------|--------|---------|
| DML WHERE clause | `:var` required | `WHERE JOB_ID = :P_JOB_ID` |
| DML SET simple assignment | `:var` required | `SET STATUS = :my_status` |
| DML SET with concatenation/expression | Use EXECUTE IMMEDIATE instead | See below |
| Procedure CALL arguments | `:var` required | `CALL proc(:P_RES, :P_MIN_LAT)` |
| Variable reassignment | No colon | `wait_count := wait_count + 1;` |
| IF/WHILE conditions | No colon | `IF (wait_count > 10) THEN` |
| String concatenation in EXECUTE IMMEDIATE | No colon (variable evaluated at build time) | `'...WHERE ID=''' \|\| my_var \|\| ''''` |

Key rule: **When a DML SET clause needs to concatenate a variable into a string value or evaluate an arithmetic expression, use EXECUTE IMMEDIATE with string concatenation. Static UPDATE SET with `:var` only works for simple scalar assignments, not for expressions like `(:wait_attempt * 15)` or string concatenation like `'prefix' \|\| :var \|\| 'suffix'`.**

### 2. EXECUTE IMMEDIATE Patterns

```sql
-- SAFE: dynamic UPDATE with variable in concatenated string
LET wait_secs INTEGER := wait_attempt * 15;
EXECUTE IMMEDIATE 'UPDATE my_table SET MSG=''Done in ' || wait_secs || 's'' WHERE ID=''' || job_id || '''';

-- SAFE: static UPDATE with simple bind
UPDATE my_table SET STATUS = :new_status WHERE JOB_ID = :P_JOB_ID;

-- BROKEN: expression in static SET clause
UPDATE my_table SET MSG = 'Done in ' || (:wait_secs * 15) || 's' WHERE ...;
```

### 3. Table Schema Checklist

When adding UPDATE statements that reference columns:
- Verify the column exists in the CREATE TABLE DDL (search for the table name in setup_script.sql)
- If the column is new, add it to both the CREATE TABLE IF NOT EXISTS definition AND run ALTER TABLE on the live table (since CREATE IF NOT EXISTS won't modify existing tables)

### 4. Deployment Checklist for setup_script.sql Changes

1. Edit `setup_script.sql`
2. `PUT` to `@OPENROUTESERVICE_NATIVE_APP_PKG.APP_SRC.STAGE/app/`
3. `ALTER APPLICATION ... UPGRADE`
4. If schema changed: also `ALTER TABLE` on the live table (CREATE IF NOT EXISTS won't add columns)

## File to Edit

[.cortex/skills/build-routing-solution/SKILL.md](.cortex/skills/build-routing-solution/SKILL.md) -- append the new section after the existing content (after the Troubleshooting section).

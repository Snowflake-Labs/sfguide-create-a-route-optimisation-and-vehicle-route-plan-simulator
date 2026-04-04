# Plan: Fix TEMPORARY TABLE Not Permitted in Native App

## Problem

Line 1629 of [setup_script.sql](native_app/app/setup_script.sql) uses `CREATE OR REPLACE TEMPORARY TABLE` in the ORS error retry logic. Native apps do not permit temporary table creation.

## Fix

Replace the 4-step temp-table pattern (CREATE temp, DELETE from raw, INSERT retry, DROP temp) with a 2-step inline subquery pattern that achieves the same result without any temporary table:

**Current (lines 1628-1643):**
```sql
CREATE OR REPLACE TEMPORARY TABLE travel_matrix.TMP_RETRY_ORIGINS AS
SELECT SEQ_ID FROM raw_table WHERE ... AND MATRIX_RESULT:durations IS NULL;

DELETE FROM raw_table WHERE SEQ_ID IN (SELECT SEQ_ID FROM travel_matrix.TMP_RETRY_ORIGINS);

INSERT INTO raw_table SELECT ... FROM queue_table q
JOIN travel_matrix.TMP_RETRY_ORIGINS t ON q.SEQ_ID = t.SEQ_ID;

DROP TABLE IF EXISTS travel_matrix.TMP_RETRY_ORIGINS;
```

**Replacement:**
```sql
DELETE FROM raw_table
WHERE SEQ_ID BETWEEN P_START_SEQ AND P_END_SEQ
AND MATRIX_RESULT:durations IS NULL;

INSERT INTO raw_table
SELECT q.SEQ_ID, q.ORIGIN_H3, q.DEST_HEX_IDS, matrix_call
FROM queue_table q
WHERE q.SEQ_ID BETWEEN P_START_SEQ AND P_END_SEQ
AND q.SEQ_ID NOT IN (SELECT SEQ_ID FROM raw_table WHERE SEQ_ID BETWEEN P_START_SEQ AND P_END_SEQ);
```

This is actually simpler and more efficient: DELETE all failed rows, then re-INSERT only the missing SEQ_IDs by comparing against what's already in the raw table.

## Deployment

1. Edit `setup_script.sql` lines 1628-1643
2. Sandbox-test the pattern
3. PUT to stage ROOT, upgrade, verify

## Guideline Update

Add to the Common Pitfalls table in [snowflake-scripting-guidelines.md](references/snowflake-scripting-guidelines.md):
```
| CREATE TEMPORARY TABLE in native app | "Operation CREATE on TEMPORARY TABLE is not permitted within APPLICATION" | Use inline subqueries or DELETE + re-INSERT with WHERE NOT IN |
```

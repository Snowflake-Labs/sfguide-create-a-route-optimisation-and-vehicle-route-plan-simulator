-- ============================================================================
-- overtime-alert.sql - warn a supervisor BEFORE an overtime threshold is crossed
-- ============================================================================
-- OPTIONAL. Not run by install_fleet_apps.sh, by deliberate choice: this file
-- creates an object whose entire purpose is to send email, and an installer that
-- starts mailing people is not acceptable. The alert is created SUSPENDED and
-- must be resumed by a human who has decided who should receive it.
--
-- This is the piece that changes behaviour rather than reporting on it. The app
-- view shows who is projected to cross a threshold; this pushes that to the
-- person who can reroster before it happens.
--
-- ---------------------------------------------------------------------------
-- BEFORE YOU RUN
-- ---------------------------------------------------------------------------
--   1. Set OT_NOTIFY_EMAIL below. It MUST be the verified email of an existing
--      Snowflake user in this account - Snowflake rejects arbitrary addresses on
--      an EMAIL notification integration, which is the single most common reason
--      this fails.
--   2. Set OT_REGION to the region to watch, or leave NULL for every loaded
--      region. The alert reads the labour contract, which is multi-region by
--      design.
--   3. Decide the schedule. Hourly is the default: overtime accrues over days,
--      so a tighter schedule burns credits for no extra warning.
--   4. Resume it explicitly (bottom of this file). Nothing sends until you do.
--
-- Privileges: EXECUTE ALERT on the account, plus CREATE ALERT on the schema and
-- USAGE on the notification integration. ACCOUNTADMIN is NOT required, but
-- creating a notification integration is an account-level object and typically
-- needs a role with CREATE INTEGRATION.
--
-- ---------------------------------------------------------------------------
-- WHY THE SUPPRESSION TABLE EXISTS
-- ---------------------------------------------------------------------------
-- An alert with an hourly schedule and a condition of "someone is projected to
-- breach" fires every single hour for the same person for the rest of the week,
-- because the condition stays true once it becomes true. That trains recipients
-- to ignore it, which is worse than having no alert. OT_NOTIFICATION_LOG records
-- (operator, week, band) once notified, and the condition excludes anything
-- already recorded - so a supervisor is told once when an operator ENTERS a band,
-- and once more if they escalate from AT_RISK to BREACH.
--
-- The log is also the audit trail for "were we warned", which is the first
-- question asked after a labour dispute.
-- ============================================================================

ALTER SESSION SET query_tag = '{"origin":"sf_sit-is-fleet","name":"oss-labor-overtime","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql","component":"overtime-alert"}}';

-- ---------------------------------------------------------------------------
-- 0. Parameters - EDIT THESE
-- ---------------------------------------------------------------------------
SET OT_NOTIFY_EMAIL = 'first.last@example.com';   -- <== verified Snowflake user email
SET OT_REGION       = NULL;                       -- <== e.g. 'SanFrancisco', or NULL for all regions
SET OT_SCHEDULE     = '60 MINUTE';

-- ---------------------------------------------------------------------------
-- 1. Notification integration
-- ---------------------------------------------------------------------------
CREATE NOTIFICATION INTEGRATION IF NOT EXISTS FLEET_LABOR_NOTIFICATIONS
    TYPE = EMAIL
    ENABLED = TRUE
    ALLOWED_RECIPIENTS = ($OT_NOTIFY_EMAIL)
    COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-labor-overtime","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql","component":"overtime-alert"}}';

-- ---------------------------------------------------------------------------
-- 2. Suppression / audit log
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS FLEET_APP.LABOR.OT_NOTIFICATION_LOG (
  OPERATOR_ID     VARCHAR,
  WEEK_START      DATE,
  OT_BAND         VARCHAR,
  REGION          VARCHAR,
  TEAM_ID         VARCHAR,
  SUPERVISOR_ID   VARCHAR,
  PROJECTED_HOURS FLOAT,
  NOTIFIED_AT     TIMESTAMP_LTZ
)
COMMENT='{"origin":"sf_sit-is-fleet","name":"oss-labor-overtime","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql","component":"overtime-alert"}}';

-- ---------------------------------------------------------------------------
-- 3. The pending-notification view
-- ---------------------------------------------------------------------------
-- Everything the alert needs, in one place, so the alert body stays trivial and
-- the same logic can be inspected by hand ("what would fire right now?").
--
-- Only the CURRENT week is considered. A completed week's overtime is a payroll
-- fact, not something anyone can still act on, and a week flagged
-- IS_PARTIAL_START is truncated at its beginning by the dataset boundary so its
-- projection is not meaningful.
CREATE OR REPLACE VIEW FLEET_APP.LABOR.VW_OT_PENDING_NOTIFICATION
  COMMENT='{"origin":"sf_sit-is-fleet","name":"oss-labor-overtime","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql","component":"overtime-alert"}}'
  AS
  SELECT w.OPERATOR_ID, w.WEEK_START, w.OT_BAND, w.REGION, w.REGION_LABEL,
         w.TEAM_ID, w.SUPERVISOR_ID, w.SHIFT_TYPE,
         w.HOURS_TO_DATE, w.PROJECTED_WEEK_HOURS, w.PROJECTED_OT_HOURS,
         w.EST_OT_COST, w.CURRENCY_CODE, w.DAYS_REMAINING,
         w.OT_THRESHOLD_2, w.OT_THRESHOLD_3
  FROM FLEET_APP.LABOR.VW_LABOR_WEEK w
  WHERE w.IS_CURRENT_WEEK
    AND NOT w.IS_PARTIAL_START
    AND w.OT_BAND IN ('AT_RISK', 'BREACH')
    AND NOT EXISTS (
      SELECT 1 FROM FLEET_APP.LABOR.OT_NOTIFICATION_LOG l
      WHERE l.OPERATOR_ID = w.OPERATOR_ID
        AND l.WEEK_START  = w.WEEK_START
        AND l.OT_BAND     = w.OT_BAND
    );

-- ---------------------------------------------------------------------------
-- 4. The action, as a procedure
-- ---------------------------------------------------------------------------
-- The alert body is a stored procedure rather than an inline BEGIN...END block,
-- for two reasons. Practically, `snow sql -f` splits a file on semicolons, so a
-- multi-statement inline alert body is torn in half and fails with a bare
-- "unexpected <EOF>" - the procedure body is dollar-quoted and survives.
-- Substantively, it makes the action independently callable: you can test the
-- digest, or fire it once for a demo, without touching the alert's schedule.
--
-- Send THEN record, never the reverse: recording first would suppress a
-- notification that failed to go out.
--
-- P_DRY_RUN builds the digest and returns it WITHOUT sending or recording, which
-- is how you check the wording before anyone receives it.
CREATE OR REPLACE PROCEDURE FLEET_APP.LABOR.SP_NOTIFY_OVERTIME_RISK(
  P_REGION VARCHAR, P_RECIPIENT VARCHAR, P_DRY_RUN BOOLEAN
)
RETURNS VARCHAR
LANGUAGE SQL
COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-labor-overtime","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql","component":"overtime-alert"}}'
EXECUTE AS CALLER
AS
$$
DECLARE
  digest VARCHAR;
  n      NUMBER;
BEGIN
  SELECT COUNT(*) INTO :n
  FROM FLEET_APP.LABOR.VW_OT_PENDING_NOTIFICATION
  WHERE (:P_REGION IS NULL OR REGION = :P_REGION);

  IF (:n = 0) THEN
    RETURN 'no pending overtime notifications';
  END IF;

  SELECT LISTAGG(line, '\n') WITHIN GROUP (ORDER BY line) INTO :digest
  FROM (
    SELECT SUPERVISOR_ID || ' / ' || TEAM_ID || ' (' || REGION_LABEL || '): '
           || OPERATOR_ID || ' on shift ' || COALESCE(SHIFT_TYPE, 'n/a')
           || ' has worked ' || TO_VARCHAR(ROUND(HOURS_TO_DATE, 1)) || 'h'
           || ' and is projected to reach ' || TO_VARCHAR(ROUND(PROJECTED_WEEK_HOURS, 1)) || 'h'
           || ' by week end (' || OT_BAND || ', ' || TO_VARCHAR(DAYS_REMAINING)
           || ' day(s) remaining, est. overtime ' || TO_VARCHAR(ROUND(PROJECTED_OT_HOURS, 1))
           || 'h costing ' || TO_VARCHAR(ROUND(EST_OT_COST, 0)) || ' ' || CURRENCY_CODE || ').' AS line
    FROM FLEET_APP.LABOR.VW_OT_PENDING_NOTIFICATION
    WHERE (:P_REGION IS NULL OR REGION = :P_REGION)
  );

  IF (:P_DRY_RUN) THEN
    RETURN 'DRY RUN - would notify ' || :n || ' operator(s):\n' || :digest;
  END IF;

  CALL SYSTEM$SEND_EMAIL(
    'FLEET_LABOR_NOTIFICATIONS',
    :P_RECIPIENT,
    'Overtime risk: operators projected to exceed weekly hours',
    'The following operators are projected to exceed a weekly hours threshold before the week ends.\n\n'
      || :digest
      || '\n\nProjections extrapolate the hours worked so far this week at the current daily rate. '
      || 'Overtime cost uses configured pay rates. Review rostering for the remaining days.\n'
  );

  INSERT INTO FLEET_APP.LABOR.OT_NOTIFICATION_LOG
    (OPERATOR_ID, WEEK_START, OT_BAND, REGION, TEAM_ID, SUPERVISOR_ID, PROJECTED_HOURS, NOTIFIED_AT)
  SELECT OPERATOR_ID, WEEK_START, OT_BAND, REGION, TEAM_ID, SUPERVISOR_ID,
         PROJECTED_WEEK_HOURS, CURRENT_TIMESTAMP()
  FROM FLEET_APP.LABOR.VW_OT_PENDING_NOTIFICATION
  WHERE (:P_REGION IS NULL OR REGION = :P_REGION);

  RETURN 'notified ' || :n || ' operator(s)';
END;
$$;

-- ---------------------------------------------------------------------------
-- 4b. The alert
-- ---------------------------------------------------------------------------
-- Created SUSPENDED by Snowflake. Nothing is sent until section 7.
CREATE OR REPLACE ALERT FLEET_APP.LABOR.ALERT_OVERTIME_RISK
  SCHEDULE = '60 MINUTE'
  COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-labor-overtime","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql","component":"overtime-alert"}}'
  IF (EXISTS (
        SELECT 1 FROM FLEET_APP.LABOR.VW_OT_PENDING_NOTIFICATION
        WHERE ($OT_REGION IS NULL OR REGION = $OT_REGION)
      ))
  THEN CALL FLEET_APP.LABOR.SP_NOTIFY_OVERTIME_RISK($OT_REGION, $OT_NOTIFY_EMAIL, FALSE);

-- ---------------------------------------------------------------------------
-- 5. Grants
-- ---------------------------------------------------------------------------
GRANT SELECT ON VIEW FLEET_APP.LABOR.VW_OT_PENDING_NOTIFICATION TO ROLE FLEET_APP_OPS;
GRANT SELECT ON VIEW FLEET_APP.LABOR.VW_OT_PENDING_NOTIFICATION TO ROLE FLEET_APP_ADMIN;
GRANT SELECT ON TABLE FLEET_APP.LABOR.OT_NOTIFICATION_LOG TO ROLE FLEET_APP_OPS;
GRANT SELECT ON TABLE FLEET_APP.LABOR.OT_NOTIFICATION_LOG TO ROLE FLEET_APP_ADMIN;
GRANT USAGE ON PROCEDURE FLEET_APP.LABOR.SP_NOTIFY_OVERTIME_RISK(VARCHAR, VARCHAR, BOOLEAN) TO ROLE FLEET_APP_OPS;
GRANT USAGE ON PROCEDURE FLEET_APP.LABOR.SP_NOTIFY_OVERTIME_RISK(VARCHAR, VARCHAR, BOOLEAN) TO ROLE FLEET_APP_ADMIN;

-- ---------------------------------------------------------------------------
-- 6. Inspect before enabling
-- ---------------------------------------------------------------------------
-- What WOULD be sent right now, without sending anything:
CALL FLEET_APP.LABOR.SP_NOTIFY_OVERTIME_RISK($OT_REGION, $OT_NOTIFY_EMAIL, TRUE);

-- The same, as rows:
SELECT SUPERVISOR_ID, TEAM_ID, OPERATOR_ID, OT_BAND,
       ROUND(HOURS_TO_DATE, 1)        AS HOURS_SO_FAR,
       ROUND(PROJECTED_WEEK_HOURS, 1) AS PROJECTED,
       DAYS_REMAINING,
       ROUND(EST_OT_COST, 0)          AS EST_OT_COST
FROM FLEET_APP.LABOR.VW_OT_PENDING_NOTIFICATION
ORDER BY PROJECTED_WEEK_HOURS DESC;

-- ---------------------------------------------------------------------------
-- 7. Enable (DELIBERATE STEP - uncomment to start sending email)
-- ---------------------------------------------------------------------------
-- A new alert is created SUSPENDED. Nothing is sent until you resume it.
--
--   ALTER ALERT FLEET_APP.LABOR.ALERT_OVERTIME_RISK RESUME;
--
-- To fire it exactly once for a demo, without leaving it running:
--
--   EXECUTE ALERT FLEET_APP.LABOR.ALERT_OVERTIME_RISK;
--
-- To reset the demo so the same operators alert again:
--
--   TRUNCATE TABLE FLEET_APP.LABOR.OT_NOTIFICATION_LOG;
--
-- Check history:
--   SELECT * FROM TABLE(INFORMATION_SCHEMA.ALERT_HISTORY(
--     SCHEDULED_TIME_RANGE_START => DATEADD('day', -1, CURRENT_TIMESTAMP())))
--   WHERE NAME = 'ALERT_OVERTIME_RISK' ORDER BY SCHEDULED_TIME DESC;

-- ---------------------------------------------------------------------------
-- Cleanup
-- ---------------------------------------------------------------------------
--   ALTER ALERT FLEET_APP.LABOR.ALERT_OVERTIME_RISK SUSPEND;
--   DROP ALERT IF EXISTS FLEET_APP.LABOR.ALERT_OVERTIME_RISK;
--   DROP VIEW IF EXISTS FLEET_APP.LABOR.VW_OT_PENDING_NOTIFICATION;
--   DROP TABLE IF EXISTS FLEET_APP.LABOR.OT_NOTIFICATION_LOG;
--   DROP INTEGRATION IF EXISTS FLEET_LABOR_NOTIFICATIONS;

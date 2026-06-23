-- 08_observability.sql
-- Per-endpoint ORS request log + ingest procedure + scheduled task.
--
-- Why (#56):
-- Until now every routing-gateway -> ORS call was a silent black box. There
-- was no way to compute p50 / p95 / error-rate per endpoint and no way to
-- tune the retry / circuit-breaker thresholds added in #50 or the
-- request-size guardrails added in #51 against real data.
--
-- This module is the observability substrate:
--   * Schema/Table: OPENROUTESERVICE_APP.OBSERVABILITY.ORS_REQUEST_LOG
--   * Aggregation view: V_ORS_METRICS_SUMMARY (last hour / 24h windows)
--   * Ingest procedure: INGEST_ORS_METRICS(window_minutes)
--   * Scheduled task: ORS_METRICS_INGEST_TASK (every 1 minute, USER_TASK)
--
-- The Python gateway writes a structured `[ORS_METRIC] {json}` line to stdout
-- for every routing call (see services/gateway/routing_service.py). The
-- ingest procedure reads SYSTEM$GET_SERVICE_LOGS, parses those lines, and
-- batch-inserts new events into ORS_REQUEST_LOG. The procedure is idempotent
-- across runs because each event carries a millisecond-precision REQUEST_TS
-- plus REQUEST_ID and we dedupe on the pair via NOT EXISTS.

ALTER SESSION SET query_tag = '{"origin":"sf_sit-is-fleet","name":"oss-observability","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}';

USE DATABASE OPENROUTESERVICE_APP;

CREATE SCHEMA IF NOT EXISTS OPENROUTESERVICE_APP.OBSERVABILITY
  COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-observability","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}';

CREATE TABLE IF NOT EXISTS OPENROUTESERVICE_APP.OBSERVABILITY.ORS_REQUEST_LOG (
    REQUEST_TS       TIMESTAMP_LTZ NOT NULL,
    REQUEST_ID       VARCHAR,
    ENDPOINT         VARCHAR NOT NULL,    -- 'directions' | 'matrix' | 'isochrones' | 'optimization' | etc.
    PROFILE          VARCHAR,             -- driving-car / driving-hgv / cycling-regular / foot-walking
    REGION           VARCHAR,
    ORS_HOST         VARCHAR,
    STATUS_CODE      NUMBER,              -- HTTP-equivalent status (200 OK; 4xx/5xx for failures)
    ERROR_CODE       VARCHAR,             -- 'timeout' | 'service_unreachable' | 'service_warming_up' | gateway-side label
    LATENCY_MS       NUMBER,
    REQUEST_BYTES    NUMBER,
    RESPONSE_BYTES   NUMBER,
    CALLER           VARCHAR              -- 'tabular' | 'post' | 'matrix_chunked' | etc.
)
CLUSTER BY (DATE_TRUNC('hour', REQUEST_TS))
DATA_RETENTION_TIME_IN_DAYS = 1
COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-observability","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}';

-- Aggregation view used by /api/observability/ors-metrics. Returns one row
-- per (window, endpoint) with p50 / p95 / error-rate. Windows are emitted
-- as a UNION so the same view answers both "last hour" and "last 24h" with
-- a single query from the control-app.
CREATE OR REPLACE VIEW OPENROUTESERVICE_APP.OBSERVABILITY.V_ORS_METRICS_SUMMARY
COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-observability","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}'
AS
WITH events AS (
    SELECT
        REQUEST_TS,
        ENDPOINT,
        PROFILE,
        REGION,
        STATUS_CODE,
        ERROR_CODE,
        LATENCY_MS,
        REQUEST_BYTES,
        RESPONSE_BYTES,
        IFF(STATUS_CODE >= 400 OR ERROR_CODE IS NOT NULL, 1, 0) AS IS_ERROR
    FROM OPENROUTESERVICE_APP.OBSERVABILITY.ORS_REQUEST_LOG
),
windowed AS (
    SELECT '1h'  AS WINDOW_NAME, e.* FROM events e WHERE e.REQUEST_TS >= DATEADD(hour, -1, SYSDATE())
    UNION ALL
    SELECT '24h' AS WINDOW_NAME, e.* FROM events e WHERE e.REQUEST_TS >= DATEADD(hour, -24, SYSDATE())
)
SELECT
    WINDOW_NAME,
    ENDPOINT,
    COUNT(*)                                     AS REQ_COUNT,
    SUM(IS_ERROR)                                AS ERROR_COUNT,
    ROUND(100.0 * SUM(IS_ERROR) / NULLIF(COUNT(*), 0), 2) AS ERROR_RATE_PCT,
    APPROX_PERCENTILE(LATENCY_MS, 0.5)           AS P50_MS,
    APPROX_PERCENTILE(LATENCY_MS, 0.95)          AS P95_MS,
    MAX(LATENCY_MS)                              AS MAX_MS,
    AVG(LATENCY_MS)                              AS AVG_MS,
    ROUND(AVG(REQUEST_BYTES), 0)                 AS AVG_REQ_BYTES,
    ROUND(AVG(RESPONSE_BYTES), 0)                AS AVG_RESP_BYTES,
    MAX(REQUEST_TS)                              AS LAST_EVENT_TS
FROM windowed
GROUP BY WINDOW_NAME, ENDPOINT
ORDER BY WINDOW_NAME, ENDPOINT;


-- ---------------------------------------------------------------------------
-- INGEST_ORS_METRICS
--
-- Reads the gateway service stdout via SYSTEM$GET_SERVICE_LOGS, extracts the
-- `[ORS_METRIC] {json}` markers, and inserts new rows into ORS_REQUEST_LOG.
-- Dedupes by REQUEST_ID. Tolerates missing fields gracefully — any malformed
-- JSON line is skipped without halting the procedure.
--
-- Inputs:
--   WINDOW_MINUTES INT  -- how far back to scan logs (default 5). The
--                          scheduled task runs every minute so 5 is plenty
--                          of overlap to survive a missed tick.
--
-- Returns: JSON {parsed: N, inserted: M, skipped: K}
-- ---------------------------------------------------------------------------
CREATE OR REPLACE PROCEDURE OPENROUTESERVICE_APP.OBSERVABILITY.INGEST_ORS_METRICS(WINDOW_MINUTES INT)
RETURNS STRING
LANGUAGE SQL
COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-observability","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}'
EXECUTE AS OWNER
AS
$$
DECLARE
    logs_text VARCHAR;
    parsed_count INTEGER DEFAULT 0;
    inserted_count INTEGER DEFAULT 0;
    skipped_count INTEGER DEFAULT 0;
    cutoff_minutes INTEGER DEFAULT 5;
BEGIN
    IF (WINDOW_MINUTES IS NOT NULL AND WINDOW_MINUTES > 0) THEN
        cutoff_minutes := WINDOW_MINUTES;
    END IF;

    -- Pull the most recent N lines from each gateway container instance.
    -- The gateway runs with MIN_INSTANCES=3, but SYSTEM$GET_SERVICE_LOGS
    -- returns the aggregate stream so a single call suffices.
    -- Container name 'reverse-proxy' matches routing-gateway-service.yaml. (#audit-pr-120)
    BEGIN
        SELECT SYSTEM$GET_SERVICE_LOGS(
            'OPENROUTESERVICE_APP.CORE.ROUTING_GATEWAY_SERVICE',
            0,
            'reverse-proxy',
            1000
        ) INTO :logs_text;
    EXCEPTION WHEN OTHER THEN
        logs_text := '';
    END;

    IF (logs_text IS NULL OR LENGTH(logs_text) = 0) THEN
        RETURN OBJECT_CONSTRUCT('parsed', 0, 'inserted', 0, 'skipped', 0, 'reason', 'empty_logs')::STRING;
    END IF;

    -- Stash candidates in a temporary table so we can do a NOT EXISTS dedupe
    -- against the persistent log on insert.
    CREATE OR REPLACE TEMPORARY TABLE _ORS_METRIC_CANDIDATES AS
    WITH lines AS (
        SELECT VALUE AS LINE
        FROM TABLE(SPLIT_TO_TABLE(:logs_text, '\n'))
        WHERE VALUE LIKE '%[ORS_METRIC]%'
          AND POSITION('{', VALUE) > 0
    ),
    parsed AS (
        SELECT
            TRY_PARSE_JSON(SUBSTR(LINE, POSITION('{', LINE))) AS J
        FROM lines
    )
    SELECT
        TRY_TO_TIMESTAMP_LTZ(J:"ts"::STRING)                                AS REQUEST_TS,
        J:"request_id"::STRING                                              AS REQUEST_ID,
        J:"endpoint"::STRING                                                AS ENDPOINT,
        J:"profile"::STRING                                                 AS PROFILE,
        J:"region"::STRING                                                  AS REGION,
        J:"ors_host"::STRING                                                AS ORS_HOST,
        TRY_TO_NUMBER(J:"status"::STRING)                                   AS STATUS_CODE,
        J:"error"::STRING                                                   AS ERROR_CODE,
        TRY_TO_NUMBER(J:"latency_ms"::STRING)                               AS LATENCY_MS,
        TRY_TO_NUMBER(J:"req_bytes"::STRING)                                AS REQUEST_BYTES,
        TRY_TO_NUMBER(J:"resp_bytes"::STRING)                               AS RESPONSE_BYTES,
        J:"caller"::STRING                                                  AS CALLER
    FROM parsed
    WHERE J IS NOT NULL
      AND J:"endpoint" IS NOT NULL
      AND TRY_TO_TIMESTAMP_LTZ(J:"ts"::STRING) >= DATEADD(minute, -:cutoff_minutes, CURRENT_TIMESTAMP());

    SELECT COUNT(*) INTO :parsed_count FROM _ORS_METRIC_CANDIDATES;

    INSERT INTO OPENROUTESERVICE_APP.OBSERVABILITY.ORS_REQUEST_LOG (
        REQUEST_TS, REQUEST_ID, ENDPOINT, PROFILE, REGION, ORS_HOST,
        STATUS_CODE, ERROR_CODE, LATENCY_MS, REQUEST_BYTES, RESPONSE_BYTES, CALLER
    )
    SELECT
        c.REQUEST_TS, c.REQUEST_ID, c.ENDPOINT, c.PROFILE, c.REGION, c.ORS_HOST,
        c.STATUS_CODE, c.ERROR_CODE, c.LATENCY_MS, c.REQUEST_BYTES, c.RESPONSE_BYTES, c.CALLER
    FROM _ORS_METRIC_CANDIDATES c
    WHERE c.REQUEST_ID IS NOT NULL
      AND NOT EXISTS (
            SELECT 1 FROM OPENROUTESERVICE_APP.OBSERVABILITY.ORS_REQUEST_LOG l
            WHERE l.REQUEST_ID = c.REQUEST_ID AND l.REQUEST_TS = c.REQUEST_TS
        );

    inserted_count := SQLROWCOUNT;
    skipped_count := GREATEST(parsed_count - inserted_count, 0);

    DROP TABLE IF EXISTS _ORS_METRIC_CANDIDATES;

    RETURN OBJECT_CONSTRUCT(
        'parsed', parsed_count,
        'inserted', inserted_count,
        'skipped', skipped_count,
        'window_minutes', cutoff_minutes
    )::STRING;
EXCEPTION WHEN OTHER THEN
    DROP TABLE IF EXISTS _ORS_METRIC_CANDIDATES;
    RETURN OBJECT_CONSTRUCT('error', SQLERRM, 'parsed', parsed_count, 'inserted', inserted_count)::STRING;
END;
$$;


-- Scheduled task: runs every minute via SERVERLESS_TASK on the
-- ROUTING_ANALYTICS warehouse already used by the matrix pipeline.
-- The task is paused at create time; the deploy script (or operator) runs
--   ALTER TASK ORS_METRICS_INGEST_TASK RESUME;
-- after the gateway image emitting [ORS_METRIC] lines is rolled out, so
-- ingest does not start producing zero-row noise before the producer ships.
CREATE OR REPLACE TASK OPENROUTESERVICE_APP.OBSERVABILITY.ORS_METRICS_INGEST_TASK
    WAREHOUSE = ROUTING_ANALYTICS
    SCHEDULE = '1 MINUTE'
    COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-observability","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}'
AS
    CALL OPENROUTESERVICE_APP.OBSERVABILITY.INGEST_ORS_METRICS(5);

ALTER TASK OPENROUTESERVICE_APP.OBSERVABILITY.ORS_METRICS_INGEST_TASK SUSPEND;

-- Retention purge: keep 30 days of request-log history. Without this the
-- table grows unbounded (5000-line/min ingest) and the V_ORS_METRICS_SUMMARY
-- view's APPROX_PERCENTILE scans become increasingly expensive over months.
-- Created suspended; resume after the ingest task is up. (#audit-pr-120)
CREATE OR REPLACE TASK OPENROUTESERVICE_APP.OBSERVABILITY.ORS_REQUEST_LOG_PURGE_TASK
    WAREHOUSE = ROUTING_ANALYTICS
    SCHEDULE = 'USING CRON 0 4 * * * UTC'
    COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-observability","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql","feature":"retention"}}'
AS
    DELETE FROM OPENROUTESERVICE_APP.OBSERVABILITY.ORS_REQUEST_LOG
    WHERE REQUEST_TS < DATEADD(day, -30, CURRENT_TIMESTAMP());

ALTER TASK OPENROUTESERVICE_APP.OBSERVABILITY.ORS_REQUEST_LOG_PURGE_TASK SUSPEND;

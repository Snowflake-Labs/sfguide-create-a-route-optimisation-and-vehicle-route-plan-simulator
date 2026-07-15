-- =============================================================================
-- sap-fleet-connector : overlap_selfcheck.sql  (Step 4 - IN-ACCOUNT validation)
-- =============================================================================
-- The telematics<->SAP join cannot be validated from Snowhouse (metadata only),
-- so this runs in the customer account and reports key overlap. Informational,
-- not a hard gate. READ-ONLY. Substitute {{TELEMATICS_TABLE}} / {{DEVICE_COL}}.
-- =============================================================================
ALTER SESSION SET query_tag = '{"origin":"sf_sit-is-fleet","name":"oss-sap-fleet-connector","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql","module":"overlap"}}';

WITH tel AS (
  SELECT DISTINCT SAP_SOURCE.FLEET.NORMALIZE_SERIAL({{DEVICE_COL}}) AS K
  FROM {{TELEMATICS_TABLE}}
  WHERE {{DEVICE_COL}} IS NOT NULL
),
sap AS (
  SELECT DISTINCT SERIAL AS K FROM SAP_SOURCE.FLEET.ASSET_CROSSWALK WHERE SERIAL IS NOT NULL
),
isect AS (
  SELECT COUNT(*) AS MATCHED FROM tel JOIN sap USING (K)
)
SELECT (SELECT COUNT(*) FROM tel)  AS DISTINCT_TELEMETRY_KEYS,
       (SELECT COUNT(*) FROM sap)  AS DISTINCT_SAP_KEYS,
       (SELECT MATCHED FROM isect) AS MATCHED_KEYS,
       ROUND(100.0 * (SELECT MATCHED FROM isect) / NULLIF((SELECT COUNT(*) FROM tel),0), 1) AS PCT_OF_TELEMETRY_MATCHED,
       ROUND(100.0 * (SELECT MATCHED FROM isect) / NULLIF((SELECT COUNT(*) FROM sap),0), 1) AS PCT_OF_SAP_MATCHED;

-- Sample of telematics keys with NO SAP match (normalization tuning input).
SELECT t.K AS UNMATCHED_TELEMETRY_KEY
FROM (SELECT DISTINCT SAP_SOURCE.FLEET.NORMALIZE_SERIAL({{DEVICE_COL}}) AS K FROM {{TELEMATICS_TABLE}}) t
LEFT JOIN SAP_SOURCE.FLEET.ASSET_CROSSWALK x ON x.SERIAL = t.K
WHERE x.SERIAL IS NULL AND t.K IS NOT NULL
LIMIT 50;

-- Normalized-key collisions (leading-zero strip merged distinct serials).
SELECT SAP_SOURCE.FLEET.NORMALIZE_SERIAL(SERNR) AS NORM_KEY, COUNT(DISTINCT SERNR) AS RAW_VARIANTS
FROM SAP_SOURCE.FLEET.SRC_EQUI_CURRENT
GROUP BY 1 HAVING COUNT(DISTINCT SERNR) > 1
ORDER BY RAW_VARIANTS DESC LIMIT 50;

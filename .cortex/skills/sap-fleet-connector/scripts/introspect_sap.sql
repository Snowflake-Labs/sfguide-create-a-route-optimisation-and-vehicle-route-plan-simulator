-- =============================================================================
-- sap-fleet-connector : introspect_sap.sql  (Step 2 - discovery, READ-ONLY)
-- =============================================================================
-- Discovers which SAP + telematics objects are landed and in what form, so the
-- operator can reconcile sap-mapping.yaml before binding. Pure SELECTs; creates
-- nothing. Replace {{SAP_SCHEMA}} / {{TELEMATICS_SCHEMA}} (or run per database).
-- =============================================================================
ALTER SESSION SET query_tag = '{"origin":"sf_sit-is-fleet","name":"oss-sap-fleet-connector","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql","module":"introspect"}}';

-- 1. Which SAP fleet objects are present (raw tables OR CDS views)?
SELECT table_schema, table_name, row_count, bytes,
       CASE
         WHEN table_name ILIKE 'I/_%' ESCAPE '/' OR table_name ILIKE 'C/_%' ESCAPE '/' THEN 'cds_view'
         WHEN table_name ILIKE 'Z%' THEN 'custom_cds_or_table'
         ELSE 'raw_table'
       END AS exposure_form
FROM {{SAP_DB}}.INFORMATION_SCHEMA.TABLES
WHERE UPPER(table_name) REGEXP '.*(EQUI|IFLOT|IMRG|QMEL|AUFK|AFIH|AFRU|LIKP|LIPS|VBAK|VBAP|MSEG|MKPF|BSEG|/SCMTMS/).*'
ORDER BY table_schema, table_name;

-- 2. CDC tool fingerprint: which metadata columns exist on the SAP tables?
SELECT table_schema, table_name, column_name
FROM {{SAP_DB}}.INFORMATION_SCHEMA.COLUMNS
WHERE UPPER(column_name) IN
      ('MANDT','HEADER__CHANGE_OPER','HEADER__TIMESTAMP','ODQ_CHANGEMODE','ODQ_ENTITYCNTR',
       '_FIVETRAN_SYNCED','_FIVETRAN_DELETED','LASTCHANGEDATETIME','PSA_CDC_OPERATION')
ORDER BY table_schema, table_name, column_name;

-- 3. Telematics fact shape: candidate device-id / ts / lat / lon columns.
SELECT table_schema, table_name, column_name, data_type
FROM {{TELEMATICS_DB}}.INFORMATION_SCHEMA.COLUMNS
WHERE UPPER(column_name) REGEXP
      '.*(SERIAL|VIN|UNIT|DEVICE|MMSI|IMO|TS|TIME|TIMESTAMP|LAT|LON|LNG|SPEED|HEADING|COURSE|ODOMETER).*'
ORDER BY table_schema, table_name, ordinal_position;

-- 4. Coverage summary the operator pastes back into sap-mapping.yaml review.
SELECT 'Review the three result sets, then set sap-mapping.yaml: '
    || 'sap_schema, telematics_table, cdc.tool, cdc.client (MANDT), join.strategy, region.'
       AS next_step;

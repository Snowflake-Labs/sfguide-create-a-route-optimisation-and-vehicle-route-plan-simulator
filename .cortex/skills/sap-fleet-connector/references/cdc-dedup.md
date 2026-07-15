# CDC-dedup "current-row" layer (L1)

SAP lands in Snowflake via a replication tool that streams change-data. The raw landed tables
therefore contain multiple versions per business key (insert/update/delete deltas) plus tool
metadata columns. Before any semantic mapping, the connector builds "current-row" views that
collapse each key to its latest live version and filter the SAP client (MANDT). All L4 SAP
source views ([`sap_source_views.sql`](../scripts/sap_source_views.sql)) read these L1 views,
never the raw CDC tables.

## What L1 does

1. Dedupe to the latest version per primary key.
2. Drop deleted rows.
3. Filter to the productive client (`MANDT = '<client>'`, default `'100'`).
4. Tolerate customer custom fields (`ZZ*`, `YY1_CF_*`, `/SAPCEM/*`, `J_3G*`) - select only the
   columns the mapping needs; never `SELECT *` assuming a fixed shape.

## Per replication tool (set `cdc.tool` in `sap-mapping.yaml`)

### Qlik Replicate
Metadata columns: `header__change_oper` (`I`/`U`/`D`), `header__timestamp`, plus `QREP_*` /
`RECORD_*` / `PSA_CDC_OPERATION` depending on the apply mode. Pattern:

```sql
-- current-row over a Qlik-replicated table
SELECT * EXCLUDE (header__change_oper, header__timestamp)
FROM (
  SELECT t.*,
         ROW_NUMBER() OVER (PARTITION BY <pk> ORDER BY header__timestamp DESC) AS rn
  FROM <raw>.<TABLE> t
  WHERE MANDT = '<client>'
)
WHERE rn = 1 AND header__change_oper <> 'D';
```

### SAP ODP / ODQ
Metadata: `ODQ_CHANGEMODE` (`C`/`U`/`D`), `ODQ_ENTITYCNTR`. Tables like `LIS_CDC_REP_HANA`.
Dedupe by `ODQ_ENTITYCNTR DESC`, drop `ODQ_CHANGEMODE = 'D'`.

### Fivetran SAP HANA
Metadata: `_fivetran_synced`, `_fivetran_deleted`. Columns are lowercased. Pattern:

```sql
SELECT * EXCLUDE (_fivetran_synced, _fivetran_deleted)
FROM (
  SELECT t.*, ROW_NUMBER() OVER (PARTITION BY <pk> ORDER BY _fivetran_synced DESC) AS rn
  FROM <raw>.<table> t
  WHERE mandt = '<client>'
)
WHERE rn = 1 AND NOT COALESCE(_fivetran_deleted, FALSE);
```

### Raw transparent / SLT
Tables carry `MANDT` and a `LASTCHANGEDATETIME` (or `AEDAT`/`AEZEIT`). Dedupe by latest change
ts; SLT also exposes an operation flag in some configs. If the table is a full periodic copy
(no CDC), no dedupe is needed - just the MANDT filter.

## CDS-view exposure (S/4HANA)
When the customer exposes CDS views (`I_*`, `C_*`, or custom `Z*`) instead of raw tables, the
CDS layer has usually already deduped and dropped MANDT - in that case L1 is a thin pass-through
(or omitted), and `sap-mapping.yaml` sets `cdc.tool: cds_view`. Datasphere consumption views
behave the same way.

## Config surface

`sap-mapping.yaml` carries `cdc.tool` (qlik | odp | fivetran | slt_raw | cds_view), `cdc.client`
(MANDT), and per-table `pk` + `change_ts` overrides. A new account is a config block; the L1
generation logic is unchanged.

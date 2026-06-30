# Conventions: tracking tags (sap-fleet-connector)

Every session this skill opens MUST set the query tag before running statements:

```sql
ALTER SESSION SET query_tag = '{"origin":"sf_sit-is-fleet","name":"oss-sap-fleet-connector","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}';
```

Every object this skill creates MUST carry the COMMENT tracking tag:

```sql
COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-sap-fleet-connector","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"<sql|app|notebook>"}}'
```

For objects created via CTAS or dynamic SQL (no inline COMMENT support), apply
`ALTER <object> ... SET COMMENT = '...'` immediately after creation.

These two mechanisms (session `query_tag` + object `COMMENT`) are both required and let
`routing-solution-cleanup` discover every object this skill created (all carry
`name: oss-sap-fleet-connector`).

Note: this skill also `CREATE OR REPLACE`s functions/views it does NOT own (the
`FLEET_APP.UNIFIED_FLEET.F_VW_*_SCOPED` seam). Those replacements carry the
`oss-sap-fleet-connector` tag so the rebind is attributable and reversible (re-running
`install-fleet-apps`'s `unified_fleet` pack restores the `oss-install-fleet-apps` originals).

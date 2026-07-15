# Step 0: co-locate SAP + telematics into one account

Field discovery across SAP fleet accounts shows SAP and telematics almost always land in
SEPARATE Snowflake accounts, and there is typically NO join between them in Snowflake yet:

| Pattern | Typical state |
|---|---|
| SAP-owning account | EAM/SD (or finance) present; no telemetry |
| Telematics-owning account | high-volume GPS facts; no SAP keys |
| Cross-account join today | rare/exploratory at best, not industrialized |

So the join the accelerator productionizes does not exist yet. Before any crosswalk or binding,
the two sources must be reachable from ONE account - the account where `FLEET_APP` lives.

## Methods (set `colocation.method` in `sap-mapping.yaml`)

### data_share (preferred)
The account that owns each source grants a secure share; the `FLEET_APP` account mounts them as
inbound databases. No data movement, no copy cost, always current.

```sql
-- On the FLEET_APP (consumer) account, after the provider grants the shares:
CREATE DATABASE IF NOT EXISTS SAP_INBOUND        FROM SHARE <sap_provider_account>.<sap_share>;
CREATE DATABASE IF NOT EXISTS TELEMATICS_INBOUND FROM SHARE <tel_provider_account>.<tel_share>;
```
Then point `colocation.sap_inbound_db` / `colocation.telematics_inbound_db` at these, and set
`sap_schema` / `telematics_table` to the inbound paths. Cross-region/cross-cloud shares require
the provider to enable replication of the share first.

### replication
When a share is not possible (different org, governance, or the telematics volume needs local
clustering), replicate the needed objects into the `FLEET_APP` account. Heavier (storage + sync
lag) - prefer `data_share` unless a hard blocker exists. Telematics is 45B-135B rows, so
replicate only the columns the mapping needs and cluster on `(device_id, ts)`.

### same_account
Both sources already in one account (rare today). Skip Step 0; set `colocation.method:
same_account` and point `sap_schema` / `telematics_table` directly.

## What downstream steps assume

After Step 0, `introspect_sap.sql`, `build_crosswalk.sql`, and `sap_source_views.sql` all read
from the co-located paths (inbound DBs or local). The `ASSET_CROSSWALK` join and the
`overlap_selfcheck.sql` only make sense once both sides are queryable in the same account - that
is the whole point of Step 0.

## Caveat on the discovery signal

Cross-account access history reports which columns are read, never their values, and may not
cover every account in a window. So co-join frequency is a directional FLOOR, and any "SAP key
present" signal can over-count (the `SERNR` column string appears in non-EQUI SAP tables too).
The direction is unambiguous regardless: co-location is net-new work at essentially every SAP
fleet account.

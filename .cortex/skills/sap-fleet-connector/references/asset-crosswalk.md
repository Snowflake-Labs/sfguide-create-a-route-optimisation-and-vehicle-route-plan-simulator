# ASSET_CROSSWALK - the telematics <-> SAP join seam

The single hardest problem in the connector: telematics rows identify a device, SAP rows
identify an equipment. They rarely share a clean key. The `ASSET_CROSSWALK` is a per-account
bridge that resolves any device identifier to a neutral `asset_id` (= `EQUI.EQUNR` when SAP
equipment exists). Every `fact_position` / `fact_journey` join to a SAP entity goes through it.

This is MANDATORY for all accounts. Only the `native_serial` strategy can populate it with a
direct view (no manual bridge rows); the rest need a 2-hop or external master.

## Table

```sql
-- SAP_SOURCE.FLEET.ASSET_CROSSWALK
asset_id   VARCHAR   -- neutral entity id = EQUI.EQUNR when SAP equipment exists, else external master id
serial     VARCHAR   -- normalize_serial(EQUI.SERNR); the native_serial join key
vin        VARCHAR   -- normalized VIN (vin_2hop / vin_external strategies); NULL for native_serial
device_id  VARCHAR   -- telematics device/unit id exactly as it appears in the GPS fact
source     VARCHAR   -- strategy/provenance: native_serial | vin_2hop | vin_external | marine
```

## normalize_serial()

SAP `EQUI.SERNR` is `TEXT(18)` zero-padded + uppercased; telematics serial is free-text (often
`TEXT(255)`, and VIN feeds can be ungoverned wide text). Apply the SAME normalization on BOTH
sides of any comparison:

```sql
CREATE OR REPLACE FUNCTION SAP_SOURCE.FLEET.normalize_serial(x VARCHAR)
RETURNS VARCHAR
AS $$ REGEXP_REPLACE(UPPER(TRIM(x)), '^0+', '') $$;
```

Caveat: stripping leading zeros can collide if two serials differ only by leading zeros (rare).
The install-time self-check ([`overlap_selfcheck.sql`](../scripts/overlap_selfcheck.sql)) reports
any normalized-key collisions so they can be excluded from the strip rule per account.

## Resolution strategies (set per account in `sap-mapping.yaml`)

### native_serial
Telemetry serial joins directly to `EQUI.SERNR` after normalization. The crosswalk is a VIEW,
no bridge rows:

```sql
SELECT e.EQUNR AS asset_id,
       SAP_SOURCE.FLEET.normalize_serial(e.SERNR) AS serial,
       NULL AS vin,
       SAP_SOURCE.FLEET.normalize_serial(e.SERNR) AS device_id,  -- telemetry serial normalizes to same
       'native_serial' AS source
FROM <SAP>.EQUI e
WHERE e.SERNR IS NOT NULL;
```

### vin_2hop
The GPS fact key is a message/device id, not a vehicle id. Two hops: device -> VIN/chassis
(the telematics vehicle master / device index) -> `EQUI.SERNR`. The crosswalk is built by
joining the device index to EQUI on VIN/chassis.

### vin_external
SAP is finance-only (BSEG/EKKO), there is NO EQUI. VIN binds to an external fleet-asset master,
which IS the crosswalk. `asset_id` comes from that master, not from SAP. VIN must be normalized
and validated (ungoverned wide text -> trim, uppercase, length-check to 17, drop non-alphanumerics).

### marine
Assets are vessels. Key is `MMSI`/`IMO` joined to a vessel master from an AIS provider.
`asset_id` = IMO. This is a separate template (fact_position lat/lon from AIS, no road EQUI).

## Where the crosswalk is used

`fact_position` and `fact_journey` SAP source views join the telematics fact to
`ASSET_CROSSWALK ON normalize_serial(telemetry.<device_col>) = device_id` (native) or on the
strategy-appropriate key, then carry `xwalk.asset_id` as `ENTITY_ID`. See
[`sap-entity-mapping.md`](sap-entity-mapping.md) sections 3-4.

## Install-time validation

`overlap_selfcheck.sql` runs IN the customer account (Snowhouse cannot see row values) and
reports DISTINCT telemetry keys, DISTINCT EQUI keys, the intersection count + % both
directions, a sample of unmatched keys, and normalized-key collisions. A low overlap means the
chosen strategy/normalization needs tuning before the POC proceeds - it does not block design.

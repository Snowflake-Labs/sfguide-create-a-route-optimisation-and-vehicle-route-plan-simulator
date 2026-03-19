# Plan: Add Overture Maps Auto-Install to Taxis and Food Delivery Skills

## Problem

`fleet-intelligence-taxis` and `fleet-intelligence-food-delivery` list Overture Maps datasets as prerequisites but only say "Install shares from Snowflake Marketplace" in troubleshooting. They have no auto-install SQL.

Meanwhile, `retail-catchment` and `route-optimization` already have working auto-install using:
```sql
CALL SYSTEM$ACCEPT_LEGAL_TERMS('DATA_EXCHANGE_LISTING', 'GZT0Z4CM1E9KR');
CREATE DATABASE IF NOT EXISTS OVERTURE_MAPS__PLACES FROM LISTING GZT0Z4CM1E9KR;
```

## Approach

Add a check-and-install step to both skills using the same proven pattern. Insert between infrastructure setup and first data usage.

---

## Changes

### 1. [fleet-intelligence-taxis/SKILL.md](.cortex/skills/fleet-intelligence-taxis/SKILL.md)

**Between Step 3 (Configure Database) and Step 4 (TAXI_LOCATIONS)**, add a new step:

```markdown
### Step 3b: Check & Install Overture Maps Datasets

Check if Overture Maps datasets are accessible:

1. Run `SELECT COUNT(*) FROM OVERTURE_MAPS__PLACES.CARTO.PLACE LIMIT 1`
2. Run `SELECT COUNT(*) FROM OVERTURE_MAPS__ADDRESSES.CARTO.ADDRESS LIMIT 1`

If either fails, install from Marketplace. See `references/sql-pipeline.md` Step 3b.

**STOP** if install fails -- requires IMPORT SHARE privilege.
```

Also update Prerequisites (line 86) from:
> **Overture Maps Data** shares: `OVERTURE_MAPS__PLACES`, `OVERTURE_MAPS__ADDRESSES`

To:
> **Overture Maps Data** -- auto-installed in Step 3b if missing. Requires IMPORT SHARE privilege.

### 2. [fleet-intelligence-taxis/references/sql-pipeline.md](.cortex/skills/fleet-intelligence-taxis/references/sql-pipeline.md)

**Before the Step 4 section** (line ~98), insert:

```markdown
## Step 3b: Check & Install Overture Maps Datasets

Check if datasets are accessible:
\`\`\`sql
SELECT COUNT(*) FROM OVERTURE_MAPS__PLACES.CARTO.PLACE LIMIT 1;
SELECT COUNT(*) FROM OVERTURE_MAPS__ADDRESSES.CARTO.ADDRESS LIMIT 1;
\`\`\`

If either query fails, install from Marketplace:
\`\`\`sql
CALL SYSTEM$ACCEPT_LEGAL_TERMS('DATA_EXCHANGE_LISTING', 'GZT0Z4CM1E9KR');
CREATE DATABASE IF NOT EXISTS OVERTURE_MAPS__PLACES FROM LISTING GZT0Z4CM1E9KR;
\`\`\`
\`\`\`sql
CALL SYSTEM$ACCEPT_LEGAL_TERMS('DATA_EXCHANGE_LISTING', 'GZT0Z4CM1E9NQ');
CREATE DATABASE IF NOT EXISTS OVERTURE_MAPS__ADDRESSES FROM LISTING GZT0Z4CM1E9NQ;
\`\`\`

Requires IMPORT SHARE privilege.
```

### 3. [fleet-intelligence-food-delivery/SKILL.md](.cortex/skills/fleet-intelligence-food-delivery/SKILL.md)

**Between Step 3 (Configure Database) and Steps 4-9**, add:

```markdown
### Step 3b: Check & Install Overture Maps Datasets

Check if Overture Maps datasets are accessible:

1. Run `SELECT COUNT(*) FROM OVERTURE_MAPS__PLACES.CARTO.PLACE LIMIT 1`
2. Run `SELECT COUNT(*) FROM OVERTURE_MAPS__ADDRESSES.CARTO.ADDRESS LIMIT 1`

If either fails, install from Marketplace. See `references/sql-pipeline.md` Step 3b.

**STOP** if install fails -- requires IMPORT SHARE privilege.
```

Also update Prerequisites (lines 106-108) from:
> **Overture Maps Data** shares: `OVERTURE_MAPS__PLACES`, `OVERTURE_MAPS__ADDRESSES`

To:
> **Overture Maps Data** -- auto-installed in Step 3b if missing. Requires IMPORT SHARE privilege.

### 4. [fleet-intelligence-food-delivery/references/sql-pipeline.md](.cortex/skills/fleet-intelligence-food-delivery/references/sql-pipeline.md)

**Before Step 4 (Restaurant Locations)** (line 1), insert the same check+install SQL block as taxis above.

### 5. Run Evals

Verify 50/50 evals still pass.

---

## Listing IDs (for reference)

| Dataset | Listing ID | Database |
|---------|-----------|----------|
| Overture Maps Places | `GZT0Z4CM1E9KR` | `OVERTURE_MAPS__PLACES` |
| Overture Maps Addresses | `GZT0Z4CM1E9NQ` | `OVERTURE_MAPS__ADDRESSES` |

## Files Modified (4 files)

1. `.cortex/skills/fleet-intelligence-taxis/SKILL.md` -- add Step 3b, update prerequisites
2. `.cortex/skills/fleet-intelligence-taxis/references/sql-pipeline.md` -- add install SQL
3. `.cortex/skills/fleet-intelligence-food-delivery/SKILL.md` -- add Step 3b, update prerequisites
4. `.cortex/skills/fleet-intelligence-food-delivery/references/sql-pipeline.md` -- add install SQL

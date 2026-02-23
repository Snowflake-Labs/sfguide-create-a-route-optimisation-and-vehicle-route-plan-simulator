---
name: customize-industries
description: "Customize industry categories for the demo. Use when: changing from default Food/Healthcare/Cosmetics to custom industries. Triggers: customize industries, change industries, add industry."
---

# Customize Industry Categories

Configure industry categories for the Route Optimization Simulator demo.

## Prerequisites

- Active Snowflake connection
- Demo deployed with `VEHICLE_ROUTING_SIMULATOR` database
- Access to `Notebook/add_carto_data.ipynb`

## Default Industries

The demo includes three default industries:

| Industry | Products | Customers |
|----------|----------|-----------|
| **Food** | Fresh goods, Frozen goods, Non-perishable | Supermarkets, Restaurants, Butchers |
| **Healthcare** | Pharmaceutical supplies, Medical equipment | Hospitals, Pharmacies, Dentists |
| **Cosmetics** | Hair products, Electronics, Make-up | Retail outlets, Salons |

## Workflow

### Step 1: Determine New Industries

**Goal:** Get user's industry requirements

**Actions:**

1. **Ask user** what industries they want:
   - "What industries do you want for the demo?"
   - Examples: Beverages, Electronics, Pharmaceuticals, Office Supplies, etc.

2. **For EACH industry**, gather specific details:

   | Field | Purpose | Question to Ask |
   |-------|---------|-----------------|
   | `INDUSTRY` | Display name | "What should this industry be called?" |
   | `PA` | Product type 1 (Skill 1) | "What product requires specialized handling?" |
   | `PB` | Product type 2 (Skill 2) | "What product needs careful handling?" |
   | `PC` | Product type 3 (Skill 3) | "What product is standard delivery?" |
   | `IND` | Supplier keywords | "Keywords to find suppliers/distributors?" |
   | `CTYPE` | Customer categories | "What types of businesses receive these products?" |
   | `STYPE` | Vehicle skills | "What delivery capabilities are needed for each product type?" |

**Output:** Industry specifications gathered

### Step 2: Query Available Categories

**Goal:** Show user what Overture Maps categories exist in their region

**Actions:**

1. **Execute** category query:
   ```sql
   SELECT DISTINCT CATEGORY, COUNT(*) as COUNT 
   FROM VEHICLE_ROUTING_SIMULATOR.DATA.PLACES 
   GROUP BY CATEGORY 
   ORDER BY COUNT DESC 
   LIMIT 50;
   ```

2. **Present** results to user:
   - These are valid values for `CTYPE`
   - Recommend categories with 100+ POIs
   - User can select multiple categories per industry

**Output:** User knows available categories for customer types

### Step 3: Build Industry Configuration

**Goal:** Create properly formatted industry data

**Actions:**

For each industry, generate a complete configuration:

**Example: Beverages**
```sql
SELECT
    'Beverages',                    -- INDUSTRY
    'Alcoholic Beverages',          -- PA: Skill 1 - requires age verification
    'Carbonated Drinks',            -- PB: Skill 2 - fragile, needs careful handling
    'Still Water',                  -- PC: Skill 3 - bulk/heavy items
    ARRAY_CONSTRUCT('beverage drink brewery distillery bottling winery'),
    ARRAY_CONSTRUCT('warehouse distribution depot factory wholesaler'), 
    ARRAY_CONSTRUCT('bar', 'pub', 'restaurant', 'hotel', 'supermarket', 'convenience_store'),
    ARRAY_CONSTRUCT('Age Verification Required', 'Fragile Goods Handler', 'Heavy Load Capacity')
```

**Example: Electronics**
```sql
SELECT
    'Electronics',
    'High-Value Items',             -- Secure transport needed
    'Fragile Equipment',            -- Careful handling
    'Standard Electronics',         -- Regular delivery
    ARRAY_CONSTRUCT('electronics computer phone appliance tech hardware'),
    ARRAY_CONSTRUCT('warehouse distribution depot factory wholesaler'), 
    ARRAY_CONSTRUCT('electronics_store', 'computer_store', 'mobile_phone_shop', 'department_store'),
    ARRAY_CONSTRUCT('Secure Transport', 'Fragile Goods Handler', 'Standard Delivery')
```

**Example: Pharmaceuticals**
```sql
SELECT
    'Pharmaceuticals',
    'Controlled Substances',        -- Licensed carrier required
    'Temperature Sensitive',        -- Cold chain required
    'OTC Medications',              -- Standard handling
    ARRAY_CONSTRUCT('pharmaceutical drug medicine medical prescription'),
    ARRAY_CONSTRUCT('warehouse distribution depot laboratory'), 
    ARRAY_CONSTRUCT('pharmacy', 'hospital', 'clinic', 'dentist', 'doctor'),
    ARRAY_CONSTRUCT('Licensed Pharmaceutical Carrier', 'Cold Chain Certified', 'Standard Medical Delivery')
```

**Example: Office Supplies**
```sql
SELECT
    'Office Supplies',
    'Furniture',                    -- Large items, installation
    'Electronics Equipment',        -- Fragile items
    'Paper & Consumables',          -- Bulk standard goods
    ARRAY_CONSTRUCT('office stationery furniture supplies paper equipment'),
    ARRAY_CONSTRUCT('warehouse distribution depot factory wholesaler'), 
    ARRAY_CONSTRUCT('office', 'coworking_space', 'government_office', 'bank', 'company'),
    ARRAY_CONSTRUCT('Furniture Delivery & Install', 'Fragile Equipment Handler', 'Bulk Goods Delivery')
```

**Output:** Industry SQL statements generated

### Step 4: Update Notebook

**Goal:** Modify add_carto_data.ipynb with new industries

**Actions:**

1. **Edit** Cell 15 in `Notebook/add_carto_data.ipynb`:
   - Replace the existing INSERT statement with new industries
   - Include all user-defined industries

2. **Complete INSERT statement format:**
   ```sql
   CREATE TABLE IF NOT EXISTS VEHICLE_ROUTING_SIMULATOR.DATA.LOOKUP (
       INDUSTRY VARCHAR,
       PA VARCHAR,
       PB VARCHAR,
       PC VARCHAR,
       IND ARRAY,
       IND2 ARRAY,
       CTYPE ARRAY,
       STYPE ARRAY
   );
   
   INSERT INTO VEHICLE_ROUTING_SIMULATOR.DATA.LOOKUP
   SELECT 'Industry1', 'Product A', 'Product B', 'Product C', 
          ARRAY_CONSTRUCT('keywords'), ARRAY_CONSTRUCT('warehouse'),
          ARRAY_CONSTRUCT('customer_types'), ARRAY_CONSTRUCT('skills')
   UNION ALL
   SELECT 'Industry2', ...
   UNION ALL
   SELECT 'Industry3', ...;
   ```

**Output:** Notebook updated with new industries

### Step 5: Apply Changes

**Goal:** Update the database with new industry configuration

**Actions:**

1. **Upload** modified notebook:
   ```bash
   snow stage copy "Notebook/add_carto_data.ipynb" @VEHICLE_ROUTING_SIMULATOR.NOTEBOOKS.notebook --overwrite
   ```

2. **Recreate** LOOKUP table:
   ```sql
   DROP TABLE IF EXISTS VEHICLE_ROUTING_SIMULATOR.DATA.LOOKUP;
   
   -- Execute the CREATE TABLE and INSERT from the notebook
   ```

3. **Verify** industries loaded:
   ```sql
   SELECT INDUSTRY, PA, PB, PC, CTYPE, STYPE 
   FROM VEHICLE_ROUTING_SIMULATOR.DATA.LOOKUP;
   ```

**Output:** Industry configuration applied

## Important Notes

- The Streamlit app (`routing.py`) reads industries **dynamically** from `DATA.LOOKUP`
- You do NOT need to modify the Streamlit app when changing industries
- The app will automatically show the new industries after `deploy-demo` is run

## Stopping Points

- ✋ After Step 1: Confirm industry details before generating SQL
- ✋ After Step 3: Review generated SQL with user
- ✋ After Step 5: Verify industries in database

## Output

Industry categories customized. The Simulator Streamlit will display the new industries after running `deploy-demo`.

# Industry Customization Reference

How to customize industries for the route optimization demo.

## Default Industries

| Industry | Products (PA/PB/PC) | Customers |
|----------|----------|-----------|
| **Food** | Fresh goods, Frozen goods, Non-perishable | Supermarkets, Restaurants, Butchers |
| **Healthcare** | Pharmaceutical supplies, Medical equipment, OTC | Hospitals, Pharmacies, Dentists |
| **Cosmetics** | Hair products, Electronics, Make-up | Retail outlets, Salons |

## Custom Industry SQL Format

Update Cell 15 (the LOOKUP INSERT) in `add_carto_data.ipynb`:

```sql
CREATE TABLE IF NOT EXISTS FLEET_INTELLIGENCE.ROUTE_OPTIMIZATION.LOOKUP (
    INDUSTRY VARCHAR,
    PA VARCHAR,
    PB VARCHAR,
    PC VARCHAR,
    IND ARRAY,
    IND2 ARRAY,
    CTYPE ARRAY,
    STYPE ARRAY
)
COMMENT = '{"origin":"sf_sit-is-fleet", "name":"oss-route-optimization", "version":{"major":1, "minor":0}, "attributes":{"is_quickstart":1, "source":"sql"}}';

INSERT INTO FLEET_INTELLIGENCE.ROUTE_OPTIMIZATION.LOOKUP
SELECT '<Industry1>', '<Product A>', '<Product B>', '<Product C>',
       ARRAY_CONSTRUCT('<keywords>'), ARRAY_CONSTRUCT('warehouse', 'distribution', 'depot'),
       ARRAY_CONSTRUCT('<customer_type1>', '<customer_type2>'),
       ARRAY_CONSTRUCT('<skill1>', '<skill2>', '<skill3>')
UNION ALL
SELECT '<Industry2>', ...
UNION ALL
SELECT '<Industry3>', ...;
```

## Field Specifications

| Field | Purpose | Description |
|-------|---------|-------------|
| `INDUSTRY` | Display name | Shown in Streamlit sidebar dropdown |
| `PA` | Product type 1 (Skill 1) | Product requiring specialized handling |
| `PB` | Product type 2 (Skill 2) | Product needing careful handling |
| `PC` | Product type 3 (Skill 3) | Standard delivery product |
| `IND` | Supplier keywords | Keywords to find suppliers/distributors in POI data |
| `IND2` | Supplier location types | Keywords for supplier location types (e.g., warehouse, depot) |
| `CTYPE` | Customer categories | Overture Maps place categories that are customers for this industry |
| `STYPE` | Vehicle skills | Delivery capability labels assigned to vehicles (one per product type) |

The Streamlit app reads industries dynamically from the `LOOKUP` table. No Streamlit code changes are needed when changing industries.

## Example: Beverages

```sql
SELECT 'Beverages', 'Alcoholic Beverages', 'Carbonated Drinks', 'Still Water',
       ARRAY_CONSTRUCT('beverage drink brewery distillery bottling winery'),
       ARRAY_CONSTRUCT('warehouse distribution depot factory wholesaler'), 
       ARRAY_CONSTRUCT('bar', 'pub', 'restaurant', 'hotel', 'supermarket', 'convenience_store'),
       ARRAY_CONSTRUCT('Age Verification Required', 'Fragile Goods Handler', 'Heavy Load Capacity')
```

## Example: Electronics

```sql
SELECT 'Electronics', 'High-Value Items', 'Fragile Equipment', 'Standard Electronics',
       ARRAY_CONSTRUCT('electronics computer phone appliance tech hardware'),
       ARRAY_CONSTRUCT('warehouse distribution depot factory wholesaler'), 
       ARRAY_CONSTRUCT('electronics_store', 'computer_store', 'mobile_phone_shop', 'department_store'),
       ARRAY_CONSTRUCT('Secure Transport', 'Fragile Goods Handler', 'Standard Delivery')
```

## Discovering Available Categories

After the Carto notebook runs, query available Overture Maps categories to validate `CTYPE` values:
```sql
SELECT DISTINCT CATEGORY, COUNT(*) AS COUNT 
FROM FLEET_INTELLIGENCE.ROUTE_OPTIMIZATION.PLACES 
GROUP BY CATEGORY 
ORDER BY COUNT DESC 
LIMIT 50;
```

Recommend categories with 100+ POIs for reliable demo results.

## Gathering Custom Specifications

For each custom industry, ask:

| Field | Example Question |
|-------|-----------------|
| `INDUSTRY` | "What should this industry be called?" |
| `PA` | "What product requires specialized handling?" |
| `PB` | "What product needs careful handling?" |
| `PC` | "What product is standard delivery?" |
| `IND` | "Keywords to find suppliers/distributors?" |
| `CTYPE` | "What types of businesses receive these products?" |
| `STYPE` | "What delivery capabilities are needed per product type?" |
| `SOURCE_TABLE` | "Should jobs come from a custom table instead of PLACES? If so, provide the FQN." |

## Override Tables (SOURCE_TABLE)

For industries where generic Overture POIs aren't appropriate (e.g., SEN Transport needs student home addresses, not schools), create a custom override table and set `SOURCE_TABLE` in LOOKUP.

### Required Schema for Override Tables

| Column | Type | Required | Description |
|--------|------|----------|-------------|
| REGION | STRING | Yes | Region identifier (must match LOOKUP.REGION) |
| NAME | STRING | Yes | Display name for the job location |
| CATEGORY | STRING | Yes | Category label (e.g., 'student_pickup') |
| LNG | FLOAT | Yes | Longitude |
| LAT | FLOAT | Yes | Latitude |
| ADDRESS | VARIANT | No | Structured address object from Overture |
| DISPLAY_ADDRESS | STRING | No | Pre-formatted display address string |

### Example: SEN Transport Override

```sql
CREATE OR REPLACE TABLE FLEET_INTELLIGENCE.ROUTE_OPTIMIZATION.SEN_STUDENTS AS
SELECT
    'SanFrancisco' AS REGION,
    'Student ' || ROW_NUMBER() OVER (ORDER BY RANDOM()) AS NAME,
    'student_pickup' AS CATEGORY,
    ST_X(GEOMETRY) AS LNG,
    ST_Y(GEOMETRY) AS LAT,
    ADDRESS,
    ADDRESS:freeform::VARCHAR || ', ' || COALESCE(ADDRESS:locality::VARCHAR, 'San Francisco') AS DISPLAY_ADDRESS
FROM FLEET_INTELLIGENCE.ROUTE_OPTIMIZATION.PLACES
WHERE REGION = 'SanFrancisco'
  AND ADDRESS:freeform IS NOT NULL
  AND ADDRESS:locality::VARCHAR IS NOT NULL
  AND CATEGORY IN ('real_estate_agent','landmark_and_historical_building','community_services_non_profits')
ORDER BY RANDOM()
LIMIT 60;
```

Then set in LOOKUP:
```sql
UPDATE FLEET_INTELLIGENCE.ROUTE_OPTIMIZATION.LOOKUP
SET SOURCE_TABLE = 'FLEET_INTELLIGENCE.ROUTE_OPTIMIZATION.SEN_STUDENTS'
WHERE INDUSTRY = 'SEN Transport';
```

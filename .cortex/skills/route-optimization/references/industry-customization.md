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

-- =============================================================================
-- deploy-pharma-tools.sql
-- Pharma Supply Intelligence — stored procedures, semantic view, agent update
-- =============================================================================

USE ROLE ACCOUNTADMIN;
USE WAREHOUSE ROUTING_ANALYTICS;
USE DATABASE FLEET_INTELLIGENCE;
USE SCHEMA ROUTE_OPTIMIZATION;

-- =============================================================================
-- 1. TOOL_INVENTORY_STATUS
--    Returns stock status across all pharmacies (or one specific pharmacy).
--    Highlights CRITICAL drugs, near-expiry items, overstocked drugs, wastage.
-- =============================================================================

CREATE OR REPLACE PROCEDURE FLEET_INTELLIGENCE.ROUTING_AGENT.TOOL_INVENTORY_STATUS(
    PHARMACY_NAME VARCHAR DEFAULT NULL
)
RETURNS VARIANT
LANGUAGE JAVASCRIPT
COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-add-pharma-intelligence","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}'
AS
$$
try {
    var whereClause = '';
    var binds = [];
    if (PHARMACY_NAME && PHARMACY_NAME.trim() !== '') {
        whereClause = "AND UPPER(p.NAME) LIKE UPPER('%' || ? || '%')";
        binds.push(PHARMACY_NAME);
    }

    var sql = `
        SELECT
            p.NAME                                                  AS pharmacy,
            p.ADDRESS                                               AS address,
            f.DRUG_NAME                                             AS drug_name,
            f.CONDITION                                             AS condition,
            f.DRUG_CATEGORY                                         AS category,
            f.SKILL_LABEL                                           AS delivery_type,
            inv.CURRENT_STOCK_UNITS                                 AS stock_units,
            inv.REORDER_POINT                                       AS reorder_point,
            inv.MAX_CAPACITY_UNITS                                  AS max_capacity,
            inv.STOCK_STATUS                                        AS stock_status,
            inv.DAYS_TO_EXPIRY                                      AS days_to_expiry,
            inv.EXPIRY_DATE                                         AS expiry_date,
            inv.WASTAGE_UNITS_MTD                                   AS wastage_units_mtd,
            ROUND(inv.WASTAGE_VALUE_USD, 2)                         AS wastage_value_usd,
            ROUND(inv.CURRENT_STOCK_UNITS::FLOAT / NULLIF(inv.MAX_CAPACITY_UNITS,0) * 100, 1) AS capacity_pct
        FROM FLEET_INTELLIGENCE.ROUTE_OPTIMIZATION.SF_INVENTORY       inv
        JOIN FLEET_INTELLIGENCE.ROUTE_OPTIMIZATION.SF_TOP_PHARMACIES  p ON p.PHARMACY_ID = inv.PHARMACY_ID
        JOIN FLEET_INTELLIGENCE.ROUTE_OPTIMIZATION.SF_DRUG_FORMULARY  f ON f.DRUG_ID     = inv.DRUG_ID
        WHERE 1=1 ${whereClause}
        ORDER BY
            CASE inv.STOCK_STATUS WHEN 'CRITICAL' THEN 1 WHEN 'LOW' THEN 2 WHEN 'OVERSTOCKED' THEN 3 ELSE 4 END,
            inv.DAYS_TO_EXPIRY,
            inv.WASTAGE_VALUE_USD DESC
    `;

    var stmt = snowflake.createStatement({ sqlText: sql, binds: binds });
    var res  = stmt.execute();

    var critical = [], low = [], overstocked = [], near_expiry = [], high_wastage = [];
    var total_wastage_usd = 0, total_rows = 0;

    while (res.next()) {
        total_rows++;
        var row = {
            pharmacy:         res.getColumnValue('PHARMACY'),
            drug:             res.getColumnValue('DRUG_NAME'),
            condition:        res.getColumnValue('CONDITION'),
            delivery_type:    res.getColumnValue('DELIVERY_TYPE'),
            stock_units:      res.getColumnValue('STOCK_UNITS'),
            stock_status:     res.getColumnValue('STOCK_STATUS'),
            days_to_expiry:   res.getColumnValue('DAYS_TO_EXPIRY'),
            expiry_date:      String(res.getColumnValue('EXPIRY_DATE')),
            wastage_units:    res.getColumnValue('WASTAGE_UNITS_MTD'),
            wastage_usd:      res.getColumnValue('WASTAGE_VALUE_USD'),
            capacity_pct:     res.getColumnValue('CAPACITY_PCT')
        };
        total_wastage_usd += res.getColumnValue('WASTAGE_VALUE_USD') || 0;

        if (res.getColumnValue('STOCK_STATUS') === 'CRITICAL')     critical.push(row);
        if (res.getColumnValue('STOCK_STATUS') === 'LOW')          low.push(row);
        if (res.getColumnValue('STOCK_STATUS') === 'OVERSTOCKED')  overstocked.push(row);
        if (res.getColumnValue('DAYS_TO_EXPIRY') <= 30)            near_expiry.push(row);
        if (res.getColumnValue('WASTAGE_VALUE_USD') >= 200)        high_wastage.push(row);
    }

    // Sort high_wastage by value desc
    high_wastage.sort(function(a,b){ return b.wastage_usd - a.wastage_usd; });

    return {
        summary: {
            total_sku_locations:     total_rows,
            critical_count:          critical.length,
            low_count:               low.length,
            overstocked_count:       overstocked.length,
            near_expiry_count:       near_expiry.length,
            total_wastage_usd_mtd:   Math.round(total_wastage_usd * 100) / 100
        },
        critical_items:   critical.slice(0, 15),
        low_items:        low.slice(0, 10),
        overstocked_items:overstocked.slice(0, 10),
        near_expiry_items:near_expiry.slice(0, 10),
        top_wastage_items:high_wastage.slice(0, 10),
        status: 'SUCCESS'
    };
} catch(e) {
    return { error: e.message, status: 'FAILED' };
}
$$;

GRANT USAGE ON PROCEDURE FLEET_INTELLIGENCE.ROUTING_AGENT.TOOL_INVENTORY_STATUS(VARCHAR)
    TO ROLE ACCOUNTADMIN;

-- =============================================================================
-- 2. TOOL_DEMAND_FORECAST
--    Demographic-driven demand forecast for a pharmacy.
--    Uses catchment population x morbidity rates x units_per_1000.
-- =============================================================================

CREATE OR REPLACE PROCEDURE FLEET_INTELLIGENCE.ROUTING_AGENT.TOOL_DEMAND_FORECAST(
    PHARMACY_NAME  VARCHAR,
    CONDITION_FILTER VARCHAR DEFAULT NULL
)
RETURNS VARIANT
LANGUAGE JAVASCRIPT
COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-add-pharma-intelligence","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}'
AS
$$
try {
    var condFilter = '';
    var binds = [PHARMACY_NAME];
    if (CONDITION_FILTER && CONDITION_FILTER.trim() !== '') {
        condFilter = "AND UPPER(f.CONDITION) = UPPER(?)";
        binds.push(CONDITION_FILTER);
    }

    var sql = `
        SELECT
            p.NAME                          AS pharmacy,
            p.ADDRESS                       AS address,
            f.CONDITION                     AS condition,
            f.DRUG_NAME                     AS drug_name,
            f.DRUG_CATEGORY                 AS category,
            f.SKILL_LABEL                   AS delivery_type,
            fc.FORECAST_UNITS               AS forecast_units,
            fc.ACTUAL_UNITS_DISPENSED       AS actual_dispensed,
            fc.VARIANCE_PCT                 AS variance_pct,
            fc.CATCHMENT_POPULATION         AS catchment_population,
            fc.PRIMARY_MORBIDITY_PCT        AS morbidity_pct,
            fc.DEMAND_DRIVER                AS demand_driver,
            inv.CURRENT_STOCK_UNITS         AS current_stock,
            inv.STOCK_STATUS                AS stock_status,
            (fc.FORECAST_UNITS - inv.CURRENT_STOCK_UNITS) AS stock_gap,
            CASE
                WHEN fc.FORECAST_UNITS > 0
                THEN ROUND(inv.CURRENT_STOCK_UNITS::FLOAT / fc.FORECAST_UNITS * 30)
                ELSE 999
            END                             AS days_cover
        FROM FLEET_INTELLIGENCE.ROUTE_OPTIMIZATION.SF_DEMAND_FORECAST    fc
        JOIN FLEET_INTELLIGENCE.ROUTE_OPTIMIZATION.SF_TOP_PHARMACIES     p  ON p.PHARMACY_ID = fc.PHARMACY_ID
        JOIN FLEET_INTELLIGENCE.ROUTE_OPTIMIZATION.SF_DRUG_FORMULARY     f  ON f.DRUG_ID     = fc.DRUG_ID
        JOIN FLEET_INTELLIGENCE.ROUTE_OPTIMIZATION.SF_INVENTORY          inv ON inv.PHARMACY_ID = fc.PHARMACY_ID AND inv.DRUG_ID = fc.DRUG_ID
        WHERE UPPER(p.NAME) LIKE UPPER('%' || ? || '%')
        ${condFilter}
        ORDER BY fc.FORECAST_UNITS DESC
    `;

    var stmt = snowflake.createStatement({ sqlText: sql, binds: binds });
    var res  = stmt.execute();

    var drugs = [], gaps = [], high_demand = [];
    var total_forecast = 0, total_gap = 0, catchment_pop = 0;
    var pharmacy_name_found = null, pharmacy_address = null;

    while (res.next()) {
        if (!pharmacy_name_found) {
            pharmacy_name_found = res.getColumnValue('PHARMACY');
            pharmacy_address    = res.getColumnValue('ADDRESS');
            catchment_pop       = res.getColumnValue('CATCHMENT_POPULATION');
        }
        var forecast = res.getColumnValue('FORECAST_UNITS') || 0;
        var gap      = res.getColumnValue('STOCK_GAP') || 0;
        total_forecast += forecast;
        if (gap > 0) total_gap += gap;

        var row = {
            condition:        res.getColumnValue('CONDITION'),
            drug:             res.getColumnValue('DRUG_NAME'),
            category:         res.getColumnValue('CATEGORY'),
            delivery_type:    res.getColumnValue('DELIVERY_TYPE'),
            forecast_units:   forecast,
            actual_dispensed: res.getColumnValue('ACTUAL_DISPENSED'),
            variance_pct:     res.getColumnValue('VARIANCE_PCT'),
            morbidity_pct:    res.getColumnValue('MORBIDITY_PCT'),
            current_stock:    res.getColumnValue('CURRENT_STOCK'),
            stock_status:     res.getColumnValue('STOCK_STATUS'),
            stock_gap:        gap,
            days_cover:       res.getColumnValue('DAYS_COVER')
        };
        drugs.push(row);
        if (gap > 0) gaps.push(row);
        if (forecast >= 30) high_demand.push(row);
    }

    if (!pharmacy_name_found) {
        return { error: 'Pharmacy not found: ' + PHARMACY_NAME, status: 'FAILED' };
    }

    return {
        pharmacy:          pharmacy_name_found,
        address:           pharmacy_address,
        catchment_population: catchment_pop,
        forecast_month:    new Date().toISOString().slice(0,7),
        summary: {
            total_drugs_forecasted: drugs.length,
            total_forecast_units:   total_forecast,
            total_stock_gap_units:  total_gap,
            drugs_with_shortage:    gaps.length
        },
        top_demand_drugs:    high_demand.slice(0, 10),
        critical_gaps:       gaps.sort(function(a,b){ return b.stock_gap - a.stock_gap; }).slice(0, 10),
        all_drugs:           drugs,
        status: 'SUCCESS'
    };
} catch(e) {
    return { error: e.message, status: 'FAILED' };
}
$$;

GRANT USAGE ON PROCEDURE FLEET_INTELLIGENCE.ROUTING_AGENT.TOOL_DEMAND_FORECAST(VARCHAR, VARCHAR)
    TO ROLE ACCOUNTADMIN;

-- =============================================================================
-- 3. TOOL_REPLENISHMENT_PLAN
--    Generates a prioritised manufacturing/dispatch plan.
--    Groups by delivery type (cold chain first).
--    Optionally filtered by priority: URGENT / STANDARD / REVIEW
-- =============================================================================

CREATE OR REPLACE PROCEDURE FLEET_INTELLIGENCE.ROUTING_AGENT.TOOL_REPLENISHMENT_PLAN(
    PRIORITY_FILTER VARCHAR DEFAULT NULL
)
RETURNS VARIANT
LANGUAGE JAVASCRIPT
COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-add-pharma-intelligence","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}'
AS
$$
try {
    var whereClause = '';
    var binds = [];
    if (PRIORITY_FILTER && PRIORITY_FILTER.trim() !== '') {
        whereClause = "WHERE UPPER(ro.STATUS) = UPPER(?)";
        binds.push(PRIORITY_FILTER);
    }

    var sql = `
        SELECT
            ro.STATUS                       AS priority,
            ro.PRIORITY_LABEL               AS delivery_type,
            ro.DELIVERY_PRIORITY            AS delivery_skill,
            p.NAME                          AS pharmacy,
            p.ADDRESS                       AS address,
            f.DRUG_NAME                     AS drug_name,
            f.CONDITION                     AS condition,
            f.DRUG_CATEGORY                 AS category,
            ro.UNITS_REQUIRED               AS units_required,
            ro.UNIT_COST_USD                AS unit_cost_usd,
            ro.ORDER_VALUE_USD              AS order_value_usd,
            ro.DAYS_UNTIL_STOCKOUT          AS days_until_stockout,
            inv.DAYS_TO_EXPIRY              AS days_to_expiry,
            inv.WASTAGE_UNITS_MTD           AS wastage_units_mtd,
            ROUND(inv.WASTAGE_VALUE_USD,2)  AS wastage_value_usd
        FROM FLEET_INTELLIGENCE.ROUTE_OPTIMIZATION.SF_REPLENISHMENT_ORDERS ro
        JOIN FLEET_INTELLIGENCE.ROUTE_OPTIMIZATION.SF_TOP_PHARMACIES      p   ON p.PHARMACY_ID = ro.PHARMACY_ID
        JOIN FLEET_INTELLIGENCE.ROUTE_OPTIMIZATION.SF_DRUG_FORMULARY      f   ON f.DRUG_ID     = ro.DRUG_ID
        JOIN FLEET_INTELLIGENCE.ROUTE_OPTIMIZATION.SF_INVENTORY           inv ON inv.PHARMACY_ID = ro.PHARMACY_ID AND inv.DRUG_ID = ro.DRUG_ID
        ${whereClause}
        ORDER BY ro.DELIVERY_PRIORITY, ro.DAYS_UNTIL_STOCKOUT, ro.ORDER_VALUE_USD DESC
    `;

    var stmt = snowflake.createStatement({ sqlText: sql, binds: binds });
    var res  = stmt.execute();

    var cold_chain = [], controlled = [], standard = [];
    var total_value = 0, total_units = 0, urgent_count = 0;

    while (res.next()) {
        total_value += res.getColumnValue('ORDER_VALUE_USD') || 0;
        total_units += res.getColumnValue('UNITS_REQUIRED') || 0;
        if (res.getColumnValue('PRIORITY') === 'URGENT') urgent_count++;

        var row = {
            priority:           res.getColumnValue('PRIORITY'),
            pharmacy:           res.getColumnValue('PHARMACY'),
            drug:               res.getColumnValue('DRUG_NAME'),
            condition:          res.getColumnValue('CONDITION'),
            units_required:     res.getColumnValue('UNITS_REQUIRED'),
            unit_cost_usd:      res.getColumnValue('UNIT_COST_USD'),
            order_value_usd:    Math.round(res.getColumnValue('ORDER_VALUE_USD') * 100) / 100,
            days_until_stockout:res.getColumnValue('DAYS_UNTIL_STOCKOUT'),
            days_to_expiry:     res.getColumnValue('DAYS_TO_EXPIRY'),
            wastage_units:      res.getColumnValue('WASTAGE_UNITS_MTD'),
            wastage_value_usd:  res.getColumnValue('WASTAGE_VALUE_USD')
        };

        var skill = res.getColumnValue('DELIVERY_SKILL');
        if      (skill === 1) cold_chain.push(row);
        else if (skill === 2) controlled.push(row);
        else                  standard.push(row);
    }

    return {
        plan_date: new Date().toISOString().slice(0,10),
        summary: {
            total_orders:      cold_chain.length + controlled.length + standard.length,
            urgent_count:      urgent_count,
            total_units:       total_units,
            total_value_usd:   Math.round(total_value * 100) / 100,
            cold_chain_orders: cold_chain.length,
            controlled_orders: controlled.length,
            standard_orders:   standard.length
        },
        cold_chain_priority: cold_chain,
        controlled_substances: controlled,
        standard_medicines:  standard,
        dispatch_recommendation: cold_chain.length > 0
            ? 'Dispatch cold chain consignment FIRST — temperature-sensitive products with shortest shelf life'
            : 'No cold chain items pending',
        status: 'SUCCESS'
    };
} catch(e) {
    return { error: e.message, status: 'FAILED' };
}
$$;

GRANT USAGE ON PROCEDURE FLEET_INTELLIGENCE.ROUTING_AGENT.TOOL_REPLENISHMENT_PLAN(VARCHAR)
    TO ROLE ACCOUNTADMIN;

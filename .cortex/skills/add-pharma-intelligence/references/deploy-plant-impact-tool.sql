-- =============================================================================
-- TOOL_PLANT_IMPACT
-- Returns a complete impact assessment for a manufacturing plant:
-- • Alert summary (batch holds, temp excursions, delayed shipments)
-- • Active + on-hold production batches with severity
-- • Critical/low raw material inventory and inbound shipment ETAs
-- • Downstream SF pharmacy exposure for matching therapy areas
-- Used by the Cortex Agent when user clicks a plant building in the map
-- =============================================================================

CREATE OR REPLACE PROCEDURE FLEET_INTELLIGENCE.ROUTING_AGENT.TOOL_PLANT_IMPACT(
    PLANT_NAME VARCHAR
)
RETURNS VARIANT
LANGUAGE JAVASCRIPT
COMMENT = 'Plant impact assessment: batch status, raw material inventory, shipment delays, downstream pharmacy exposure'
AS
$$
try {
    // ── 1. Resolve plant ─────────────────────────────────────────────────────
    var plantSql = `
        SELECT PLANT_ID, PLANT_NAME, PLANT_CODE, CITY, COUNTRY, SPECIALISATION,
               MAX_SEVERITY, CRITICAL_BATCHES, TEMP_EXCURSIONS,
               CRITICAL_STOCK_ITEMS, DELAYED_SHIPMENTS, BATCHES_IN_PROGRESS
        FROM FLEET_INTELLIGENCE.PHARMA_SUPPLY_CHAIN.PLANT_ALERT_STATUS
        WHERE UPPER(PLANT_NAME) LIKE UPPER('%' || ? || '%')
           OR UPPER(PLANT_CODE) = UPPER(?)
        LIMIT 1`;
    var plantStmt = snowflake.createStatement({ sqlText: plantSql, binds: [PLANT_NAME, PLANT_NAME] });
    var plantRes  = plantStmt.execute();
    if (!plantRes.next()) {
        return { error: 'Plant not found: ' + PLANT_NAME, status: 'FAILED' };
    }
    var plantId          = plantRes.getColumnValue('PLANT_ID');
    var plantDisplayName = plantRes.getColumnValue('PLANT_NAME');
    var plantCode        = plantRes.getColumnValue('PLANT_CODE');
    var specialisation   = plantRes.getColumnValue('SPECIALISATION');
    var alertSummary = {
        max_severity:         plantRes.getColumnValue('MAX_SEVERITY'),
        critical_batches:     plantRes.getColumnValue('CRITICAL_BATCHES'),
        temp_excursions:      plantRes.getColumnValue('TEMP_EXCURSIONS'),
        critical_stock_items: plantRes.getColumnValue('CRITICAL_STOCK_ITEMS'),
        delayed_shipments:    plantRes.getColumnValue('DELAYED_SHIPMENTS'),
        batches_in_progress:  plantRes.getColumnValue('BATCHES_IN_PROGRESS')
    };

    // ── 2. Production batches ────────────────────────────────────────────────
    var batchSql = `
        SELECT b.BATCH_NUMBER, b.STATUS, b.DEVIATION_SEVERITY, b.DEVIATION_COUNT,
               ROUND(b.YIELD_PCT, 1) AS YIELD_PCT, b.QC_RESULT, b.BATCH_SIZE_UNITS,
               ROUND(b.COST_USD, 0) AS COST_USD,
               p.PRODUCT_NAME, p.PRODUCT_CODE, p.BUSINESS_LINE, p.FORMULATION
        FROM FLEET_INTELLIGENCE.PHARMA_SUPPLY_CHAIN.PRODUCTION_BATCHES b
        JOIN FLEET_INTELLIGENCE.PHARMA_SUPPLY_CHAIN.PRODUCTS p ON p.PRODUCT_ID = b.PRODUCT_ID
        WHERE b.PLANT_ID = ?
        ORDER BY
            CASE b.STATUS
                WHEN 'ON_HOLD'    THEN 1
                WHEN 'REJECTED'   THEN 2
                WHEN 'QC_REVIEW'  THEN 3
                WHEN 'IN_PROGRESS'THEN 4
                ELSE 5
            END,
            CASE b.DEVIATION_SEVERITY
                WHEN 'CRITICAL' THEN 1
                WHEN 'MAJOR'    THEN 2
                WHEN 'MINOR'    THEN 3
                ELSE 4
            END`;
    var batchStmt = snowflake.createStatement({ sqlText: batchSql, binds: [plantId] });
    var batchRes  = batchStmt.execute();

    var onHoldBatches = [], activeBatches = [], therapyAreas = {};
    while (batchRes.next()) {
        var status = batchRes.getColumnValue('STATUS');
        var ta     = batchRes.getColumnValue('BUSINESS_LINE');
        if (ta) therapyAreas[ta] = true;
        var row = {
            batch:             batchRes.getColumnValue('BATCH_NUMBER'),
            product:           batchRes.getColumnValue('PRODUCT_NAME'),
            product_code:      batchRes.getColumnValue('PRODUCT_CODE'),
            business_line:     ta,
            formulation:       batchRes.getColumnValue('FORMULATION'),
            status:            status,
            deviation_severity:batchRes.getColumnValue('DEVIATION_SEVERITY'),
            deviation_count:   batchRes.getColumnValue('DEVIATION_COUNT'),
            batch_size_units:  batchRes.getColumnValue('BATCH_SIZE_UNITS'),
            yield_pct:         batchRes.getColumnValue('YIELD_PCT'),
            cost_usd:          batchRes.getColumnValue('COST_USD'),
            qc_result:         batchRes.getColumnValue('QC_RESULT')
        };
        if (status === 'ON_HOLD' || status === 'REJECTED' || status === 'QC_REVIEW') {
            onHoldBatches.push(row);
        } else {
            activeBatches.push(row);
        }
    }

    // ── 3. Raw material inventory (critical / low) ───────────────────────────
    var invSql = `
        SELECT mi.STOCK_KG, mi.SAFETY_STOCK_KG, mi.DAYS_OF_COVERAGE,
               mi.STOCK_STATUS, mi.TEMP_EXCURSION_FLAG, mi.MATERIAL_TYPE,
               mi.COLD_CHAIN_REQUIRED,
               p.PRODUCT_NAME, p.PRODUCT_CODE, p.BUSINESS_LINE
        FROM FLEET_INTELLIGENCE.PHARMA_SUPPLY_CHAIN.MATERIAL_INVENTORY mi
        JOIN FLEET_INTELLIGENCE.PHARMA_SUPPLY_CHAIN.PRODUCTS p ON p.PRODUCT_ID = mi.PRODUCT_ID
        WHERE mi.PLANT_ID = ?
          AND mi.STOCK_STATUS IN ('CRITICAL', 'LOW')
        ORDER BY
            CASE mi.STOCK_STATUS WHEN 'CRITICAL' THEN 1 ELSE 2 END,
            mi.DAYS_OF_COVERAGE`;
    var invStmt = snowflake.createStatement({ sqlText: invSql, binds: [plantId] });
    var invRes  = invStmt.execute();

    var criticalInventory = [], lowInventory = [];
    while (invRes.next()) {
        var irow = {
            product:            invRes.getColumnValue('PRODUCT_NAME'),
            product_code:       invRes.getColumnValue('PRODUCT_CODE'),
            business_line:      invRes.getColumnValue('BUSINESS_LINE'),
            material_type:      invRes.getColumnValue('MATERIAL_TYPE'),
            stock_kg:           invRes.getColumnValue('STOCK_KG'),
            safety_stock_kg:    invRes.getColumnValue('SAFETY_STOCK_KG'),
            days_of_coverage:   invRes.getColumnValue('DAYS_OF_COVERAGE'),
            stock_status:       invRes.getColumnValue('STOCK_STATUS'),
            temp_excursion:     invRes.getColumnValue('TEMP_EXCURSION_FLAG'),
            cold_chain:         invRes.getColumnValue('COLD_CHAIN_REQUIRED')
        };
        if (invRes.getColumnValue('STOCK_STATUS') === 'CRITICAL') criticalInventory.push(irow);
        else lowInventory.push(irow);
    }

    // ── 4. Delayed / customs-held shipments ──────────────────────────────────
    var shipSql = `
        SELECT sh.SHIPMENT_REF, sh.STATUS, sh.DELAY_DAYS, sh.PLANNED_ARRIVAL,
               sh.DELAY_REASON, sh.QUANTITY_KG,
               ROUND(sh.TOTAL_VALUE_USD, 0) AS VALUE_USD,
               sh.COLD_CHAIN_REQUIRED,
               p.PRODUCT_NAME, p.PRODUCT_CODE,
               su.SUPPLIER_NAME, su.COUNTRY AS SUPPLIER_COUNTRY
        FROM FLEET_INTELLIGENCE.PHARMA_SUPPLY_CHAIN.SHIPMENTS sh
        JOIN FLEET_INTELLIGENCE.PHARMA_SUPPLY_CHAIN.PRODUCTS p  ON p.PRODUCT_ID  = sh.PRODUCT_ID
        JOIN FLEET_INTELLIGENCE.PHARMA_SUPPLY_CHAIN.SUPPLIERS su ON su.SUPPLIER_ID = sh.SUPPLIER_ID
        WHERE sh.PLANT_ID = ?
          AND sh.STATUS IN ('DELAYED', 'CUSTOMS', 'IN_TRANSIT')
        ORDER BY sh.DELAY_DAYS DESC NULLS LAST`;
    var shipStmt = snowflake.createStatement({ sqlText: shipSql, binds: [plantId] });
    var shipRes  = shipStmt.execute();

    var delayedShipments = [];
    while (shipRes.next()) {
        delayedShipments.push({
            ref:              shipRes.getColumnValue('SHIPMENT_REF'),
            product:          shipRes.getColumnValue('PRODUCT_NAME'),
            product_code:     shipRes.getColumnValue('PRODUCT_CODE'),
            supplier:         shipRes.getColumnValue('SUPPLIER_NAME'),
            supplier_country: shipRes.getColumnValue('SUPPLIER_COUNTRY'),
            status:           shipRes.getColumnValue('STATUS'),
            delay_days:       shipRes.getColumnValue('DELAY_DAYS'),
            planned_arrival:  String(shipRes.getColumnValue('PLANNED_ARRIVAL')),
            delay_reason:     shipRes.getColumnValue('DELAY_REASON'),
            quantity_kg:      shipRes.getColumnValue('QUANTITY_KG'),
            value_usd:        shipRes.getColumnValue('VALUE_USD'),
            cold_chain:       shipRes.getColumnValue('COLD_CHAIN_REQUIRED')
        });
    }

    // ── 5. Downstream SF pharmacy exposure ───────────────────────────────────
    // Match plant therapy areas to SF pharmacy drug categories
    var taList = Object.keys(therapyAreas);
    var exposureSql = `
        SELECT f.DRUG_NAME, f.CONDITION, f.DRUG_CATEGORY,
               inv.STOCK_STATUS, inv.DAYS_TO_EXPIRY,
               p.NAME AS pharmacy
        FROM FLEET_INTELLIGENCE.ROUTE_OPTIMIZATION.SF_INVENTORY    inv
        JOIN FLEET_INTELLIGENCE.ROUTE_OPTIMIZATION.SF_TOP_PHARMACIES p  ON p.PHARMACY_ID = inv.PHARMACY_ID
        JOIN FLEET_INTELLIGENCE.ROUTE_OPTIMIZATION.SF_DRUG_FORMULARY f  ON f.DRUG_ID     = inv.DRUG_ID
        WHERE inv.STOCK_STATUS IN ('CRITICAL', 'LOW')
        ORDER BY
            CASE inv.STOCK_STATUS WHEN 'CRITICAL' THEN 1 ELSE 2 END,
            inv.DAYS_TO_EXPIRY`;
    var expStmt = snowflake.createStatement({ sqlText: exposureSql });
    var expRes  = expStmt.execute();

    var pharmacyExposure = [];
    while (expRes.next()) {
        pharmacyExposure.push({
            pharmacy:      expRes.getColumnValue('PHARMACY'),
            drug:          expRes.getColumnValue('DRUG_NAME'),
            condition:     expRes.getColumnValue('CONDITION'),
            category:      expRes.getColumnValue('DRUG_CATEGORY'),
            stock_status:  expRes.getColumnValue('STOCK_STATUS'),
            days_to_expiry:expRes.getColumnValue('DAYS_TO_EXPIRY')
        });
    }

    // ── Return ────────────────────────────────────────────────────────────────
    return {
        plant: {
            name:          plantDisplayName,
            code:          plantCode,
            specialisation:specialisation,
            business_lines: taList
        },
        alert_summary:      alertSummary,
        on_hold_batches:    onHoldBatches.slice(0, 10),
        active_batches:     activeBatches.slice(0, 8),
        critical_inventory: criticalInventory.slice(0, 10),
        low_inventory:      lowInventory.slice(0, 8),
        delayed_shipments:  delayedShipments.slice(0, 10),
        downstream_pharmacy_exposure: pharmacyExposure.slice(0, 20),
        status: 'SUCCESS'
    };

} catch(e) {
    return { error: e.message, status: 'FAILED' };
}
$$;

GRANT USAGE ON PROCEDURE FLEET_INTELLIGENCE.ROUTING_AGENT.TOOL_PLANT_IMPACT(VARCHAR)
    TO ROLE ACCOUNTADMIN;

-- Verify
CALL FLEET_INTELLIGENCE.ROUTING_AGENT.TOOL_PLANT_IMPACT('Hudson Valley');

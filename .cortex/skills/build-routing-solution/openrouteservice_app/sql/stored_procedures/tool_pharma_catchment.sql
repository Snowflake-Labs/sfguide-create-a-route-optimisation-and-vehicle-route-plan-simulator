-- =============================================================================
-- TOOL_PHARMA_CATCHMENT
-- Analyses the population health profile within a pharmacy's catchment area.
-- Steps:
--   1. Geocode the pharmacy location using AI_COMPLETE
--   2. Generate isochrone (travel-time catchment polygon) via ORS
--   3. Find all demographic points within the catchment using ST_WITHIN
--   4. Aggregate morbidity, demographics and accessibility metrics
--   5. Return geometry + per-point data for map rendering + summary stats
-- =============================================================================

CREATE OR REPLACE PROCEDURE FLEET_INTELLIGENCE.ROUTING_AGENT.TOOL_PHARMA_CATCHMENT(
    PHARMACY_DESCRIPTION VARCHAR,
    RANGE_MINUTES        FLOAT DEFAULT 10,
    PROFILE              VARCHAR DEFAULT 'driving-car'
)
RETURNS VARIANT
LANGUAGE JAVASCRIPT
AS
$$
try {
    // Step 1: Geocode the pharmacy location
    var geocodeSQL = "SELECT AI_COMPLETE(" +
        "'claude-sonnet-4-5'," +
        "CONCAT('Return ONLY a JSON object with the latitude and longitude of this location in San Francisco. Location: ', ?)," +
        "{'temperature': 0, 'max_tokens': 100}," +
        "{'type': 'json', 'schema': {'type': 'object', 'properties': {" +
            "'latitude': {'type': 'number'}, 'longitude': {'type': 'number'}, 'name': {'type': 'string'}" +
        "}, 'required': ['latitude', 'longitude', 'name']}}" +
        ") AS result";

    var geocodeStmt = snowflake.createStatement({ sqlText: geocodeSQL, binds: [PHARMACY_DESCRIPTION] });
    var geocodeRes  = geocodeStmt.execute();
    geocodeRes.next();
    var rawGeo = geocodeRes.getColumnValue(1);
    var loc = (typeof rawGeo === 'string') ? JSON.parse(rawGeo) : rawGeo;

    if (!loc.latitude || !loc.longitude) {
        return { error: 'Could not geocode pharmacy location', status: 'FAILED' };
    }

    // Step 2: Get isochrone from ORS
    var isoSQL = "SELECT ST_ASGEOJSON(d.GEOJSON) AS GEOJSON_STR, " +
                 "d.RESPONSE:features[0]:properties:area::FLOAT AS AREA_M2 " +
                 "FROM TABLE(OPENROUTESERVICE_APP.CORE.ISOCHRONES(?, ?, ?, ?::NUMBER)) d LIMIT 1";
    var isoStmt = snowflake.createStatement({
        sqlText: isoSQL,
        binds: [PROFILE, loc.longitude, loc.latitude, RANGE_MINUTES]
    });
    var isoRes = isoStmt.execute();

    if (!isoRes.next()) {
        return { error: 'Isochrone returned no results for this location', status: 'FAILED' };
    }

    var isoGeoRaw  = isoRes.getColumnValue(1);
    var areaM2     = isoRes.getColumnValue(2) || 0;
    var areaKm2    = Math.round(areaM2 / 1000000 * 100) / 100;
    var isoGeojson = isoGeoRaw ? ((typeof isoGeoRaw === 'string') ? JSON.parse(isoGeoRaw) : isoGeoRaw) : null;
    if (!isoGeojson) {
        return { error: 'Isochrone geometry is null', status: 'FAILED' };
    }
    var isoGeojsonStr = JSON.stringify(isoGeojson).replace(/'/g, "''");

    // Step 3: Query demographics within catchment
    var demoSQL = "SELECT DEMO_ID, NEIGHBORHOOD, LATITUDE, LONGITUDE, TOTAL_POPULATION, " +
                  "PCT_ELDERLY, PCT_CHILDREN, DIABETES_PCT, HYPERTENSION_PCT, " +
                  "CARDIOVASCULAR_PCT, RESPIRATORY_PCT, MOBILITY_ISSUES_PCT, " +
                  "INCOME_BRACKET, CAR_OWNERSHIP_PCT, TRANSIT_ACCESS " +
                  "FROM FLEET_INTELLIGENCE.ROUTE_OPTIMIZATION.SF_HEALTH_DEMOGRAPHICS " +
                  "WHERE ST_WITHIN(" +
                  "  TO_GEOGRAPHY(OBJECT_CONSTRUCT('type','Point','coordinates',ARRAY_CONSTRUCT(LONGITUDE::FLOAT,LATITUDE::FLOAT)))," +
                  "  TO_GEOGRAPHY('" + isoGeojsonStr + "')" +
                  ") ORDER BY TOTAL_POPULATION DESC";

    var demoStmt = snowflake.createStatement({ sqlText: demoSQL });
    var demoRes  = demoStmt.execute();

    var neighbourhoods = [];
    var totalPop = 0, totalDiabetes = 0, totalHypertension = 0;
    var totalCardio = 0, totalRespiratory = 0, totalMobility = 0;
    var totalElderly = 0, totalChildren = 0, totalLowCar = 0;
    var lowIncome = 0, medIncome = 0, highIncome = 0;

    while (demoRes.next()) {
        var pop  = demoRes.getColumnValue(5);
        var diab = demoRes.getColumnValue(8);
        var hyp  = demoRes.getColumnValue(9);
        var card = demoRes.getColumnValue(10);
        var resp = demoRes.getColumnValue(11);
        var mob  = demoRes.getColumnValue(12);
        var inc  = demoRes.getColumnValue(13);
        var car  = demoRes.getColumnValue(14);
        var eld  = demoRes.getColumnValue(6);
        var chi  = demoRes.getColumnValue(7);

        // Morbidity risk score (0-100): weighted average of key indicators
        var riskScore = Math.min(100, Math.round(
            diab * 1.5 + hyp * 0.8 + card * 1.2 + mob * 0.9
        ));

        neighbourhoods.push({
            id:              demoRes.getColumnValue(1),
            neighborhood:    demoRes.getColumnValue(2),
            latitude:        demoRes.getColumnValue(3),
            longitude:       demoRes.getColumnValue(4),
            population:      pop,
            pct_elderly:     eld,
            pct_children:    chi,
            diabetes_pct:    diab,
            hypertension_pct: hyp,
            cardiovascular_pct: card,
            respiratory_pct: resp,
            mobility_issues_pct: mob,
            income_bracket:  inc,
            car_ownership_pct: car,
            transit_access:  demoRes.getColumnValue(15),
            risk_score:      riskScore
        });

        totalPop        += pop;
        totalDiabetes   += diab * pop;
        totalHypertension += hyp * pop;
        totalCardio     += card * pop;
        totalRespiratory += resp * pop;
        totalMobility   += mob * pop;
        totalElderly    += eld * pop;
        totalChildren   += chi * pop;
        totalLowCar     += (100 - car) * pop;

        if (inc === 'LOW')    lowIncome  += pop;
        else if (inc === 'MEDIUM') medIncome += pop;
        else                  highIncome += pop;
    }

    if (neighbourhoods.length === 0) {
        return {
            status: 'SUCCESS',
            pharmacy: { name: loc.name, longitude: loc.longitude, latitude: loc.latitude },
            range_minutes: RANGE_MINUTES,
            geometry: isoGeojson,
            area_km2: areaKm2,
            message: 'No population data found within catchment area. Try increasing range_minutes.',
            population_points: [],
            summary: {}
        };
    }

    var avgDiab  = Math.round(totalDiabetes / totalPop * 10) / 10;
    var avgHyp   = Math.round(totalHypertension / totalPop * 10) / 10;
    var avgCard  = Math.round(totalCardio / totalPop * 10) / 10;
    var avgResp  = Math.round(totalRespiratory / totalPop * 10) / 10;
    var avgMob   = Math.round(totalMobility / totalPop * 10) / 10;
    var avgEld   = Math.round(totalElderly / totalPop * 10) / 10;
    var avgChi   = Math.round(totalChildren / totalPop * 10) / 10;
    var pctNoCar = Math.round(totalLowCar / totalPop * 10) / 10;

    var highRisk  = neighbourhoods.filter(function(n) { return n.risk_score >= 55; });
    var medRisk   = neighbourhoods.filter(function(n) { return n.risk_score >= 35 && n.risk_score < 55; });
    var lowRisk   = neighbourhoods.filter(function(n) { return n.risk_score < 35; });

    return {
        status: 'SUCCESS',
        pharmacy: { name: loc.name, longitude: loc.longitude, latitude: loc.latitude },
        center: { name: loc.name, longitude: loc.longitude, latitude: loc.latitude },
        range_minutes: RANGE_MINUTES,
        geometry: isoGeojson,
        area_km2: Math.round(areaKm2 * 100) / 100,
        population_points: neighbourhoods,
        summary: {
            catchment_population:    totalPop,
            neighbourhoods_covered:  neighbourhoods.length,
            high_risk_neighbourhoods: highRisk.length,
            avg_diabetes_pct:        avgDiab,
            avg_hypertension_pct:    avgHyp,
            avg_cardiovascular_pct:  avgCard,
            avg_respiratory_pct:     avgResp,
            avg_mobility_issues_pct: avgMob,
            pct_elderly:             avgEld,
            pct_children:            avgChi,
            pct_without_car:         pctNoCar,
            income_low_pct:          Math.round(lowIncome / totalPop * 1000) / 10,
            income_medium_pct:       Math.round(medIncome / totalPop * 1000) / 10,
            income_high_pct:         Math.round(highIncome / totalPop * 1000) / 10,
            top_morbidity:           avgDiab > avgHyp ? 'Diabetes' : 'Hypertension',
            accessibility_note: pctNoCar > 40 ? 'HIGH dependency on pharmacy — majority of population has no car' :
                                pctNoCar > 25 ? 'MODERATE car-free population — good transit access needed' :
                                'Most residents have car access to pharmacy'
        }
    };
} catch(err) {
    return { error: err.message, status: 'FAILED' };
}
$$;

SELECT 'TOOL_PHARMA_CATCHMENT created successfully' AS STATUS;

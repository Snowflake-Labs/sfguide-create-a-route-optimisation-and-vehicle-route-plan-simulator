-- =============================================================================
-- SF DRUG FORMULARY: Maps morbidities to drug categories with delivery skills
-- Used by TOOL_SUPPLY_CHAIN to generate realistic delivery jobs from catchment
-- =============================================================================

USE WAREHOUSE ROUTING_ANALYTICS;
USE DATABASE FLEET_INTELLIGENCE;
USE SCHEMA ROUTE_OPTIMIZATION;

CREATE OR REPLACE TABLE FLEET_INTELLIGENCE.ROUTE_OPTIMIZATION.SF_DRUG_FORMULARY (
    DRUG_ID          NUMBER,
    CONDITION        VARCHAR,     -- maps to demographics column name
    DRUG_NAME        VARCHAR,
    DRUG_CATEGORY    VARCHAR,
    DELIVERY_SKILL   NUMBER,     -- 1=cold chain, 2=controlled, 3=standard
    SKILL_LABEL      VARCHAR,
    UNITS_PER_1000   NUMBER,     -- estimated units needed per 1000 population at 1% prevalence
    PRIORITY         NUMBER      -- 1=critical, 2=high, 3=routine
);

INSERT INTO FLEET_INTELLIGENCE.ROUTE_OPTIMIZATION.SF_DRUG_FORMULARY VALUES
-- Diabetes drugs (DIABETES_PCT)
(1,  'DIABETES', 'Insulin Glargine (Lantus)',      'Insulin',           1, 'Cold Chain',            45, 1),
(2,  'DIABETES', 'Metformin 500mg',                'Oral Hypoglycemic', 3, 'Standard Medicines',    120, 3),
(3,  'DIABETES', 'Insulin Lispro (Humalog)',       'Insulin',           1, 'Cold Chain',            30, 1),
(4,  'DIABETES', 'Glipizide 5mg',                  'Oral Hypoglycemic', 3, 'Standard Medicines',    60, 3),
(5,  'DIABETES', 'Ozempic (Semaglutide)',          'GLP-1 Agonist',     1, 'Cold Chain',            25, 2),

-- Hypertension drugs (HYPERTENSION_PCT)
(6,  'HYPERTENSION', 'Lisinopril 10mg',           'ACE Inhibitor',     3, 'Standard Medicines',    90, 2),
(7,  'HYPERTENSION', 'Amlodipine 5mg',            'Calcium Blocker',   3, 'Standard Medicines',    85, 2),
(8,  'HYPERTENSION', 'Losartan 50mg',             'ARB',               3, 'Standard Medicines',    70, 3),
(9,  'HYPERTENSION', 'Metoprolol 25mg',           'Beta Blocker',      3, 'Standard Medicines',    65, 2),
(10, 'HYPERTENSION', 'Hydrochlorothiazide 25mg',  'Thiazide Diuretic', 3, 'Standard Medicines',    55, 3),

-- Cardiovascular drugs (CARDIOVASCULAR_PCT)
(11, 'CARDIOVASCULAR', 'Atorvastatin 20mg',       'Statin',            3, 'Standard Medicines',    100, 2),
(12, 'CARDIOVASCULAR', 'Aspirin 81mg',            'Antiplatelet',      3, 'Standard Medicines',    110, 3),
(13, 'CARDIOVASCULAR', 'Clopidogrel 75mg',        'Antiplatelet',      2, 'Controlled Substances', 40, 2),
(14, 'CARDIOVASCULAR', 'Warfarin 5mg',            'Anticoagulant',     2, 'Controlled Substances', 35, 1),
(15, 'CARDIOVASCULAR', 'Nitroglycerin Sublingual', 'Nitrate',          1, 'Cold Chain',            20, 1),

-- Respiratory drugs (RESPIRATORY_PCT)
(16, 'RESPIRATORY', 'Albuterol Inhaler',          'Bronchodilator',    3, 'Standard Medicines',    80, 2),
(17, 'RESPIRATORY', 'Fluticasone Inhaler',        'Corticosteroid',    3, 'Standard Medicines',    60, 3),
(18, 'RESPIRATORY', 'Montelukast 10mg',           'Leukotriene',       3, 'Standard Medicines',    45, 3),
(19, 'RESPIRATORY', 'Prednisone 10mg',            'Corticosteroid',    2, 'Controlled Substances', 30, 2),
(20, 'RESPIRATORY', 'Budesonide Nebulizer',       'Corticosteroid',    1, 'Cold Chain',            15, 2),

-- Pain / Controlled (MOBILITY_ISSUES_PCT as proxy)
(21, 'MOBILITY', 'Tramadol 50mg',                'Opioid Analgesic',   2, 'Controlled Substances', 35, 2),
(22, 'MOBILITY', 'Gabapentin 300mg',             'Neuropathic',        2, 'Controlled Substances', 40, 3),
(23, 'MOBILITY', 'Celecoxib 200mg',              'NSAID',              3, 'Standard Medicines',    50, 3),
(24, 'MOBILITY', 'Pregabalin 75mg',              'Neuropathic',        2, 'Controlled Substances', 30, 2),
(25, 'MOBILITY', 'Diclofenac Gel',               'Topical NSAID',      3, 'Standard Medicines',    25, 3);

-- =============================================================================
-- SF_TOP_PHARMACIES: Key pharmacies for supply chain demo with pre-geocoded coords
-- =============================================================================

CREATE OR REPLACE TABLE FLEET_INTELLIGENCE.ROUTE_OPTIMIZATION.SF_TOP_PHARMACIES (
    PHARMACY_ID  NUMBER,
    NAME         VARCHAR,
    ADDRESS      VARCHAR,
    LONGITUDE    FLOAT,
    LATITUDE     FLOAT,
    PRIORITY     NUMBER  -- 1=high need, 2=medium, 3=low
);

INSERT INTO FLEET_INTELLIGENCE.ROUTE_OPTIMIZATION.SF_TOP_PHARMACIES VALUES
(1, 'Walgreens Castro',           '498 Castro St, SF',      -122.4312, 37.7616, 1),
(2, 'CVS Geary Boulevard',        '2676 Geary Blvd, SF',    -122.4506, 37.7798, 1),
(3, 'Rite Aid Clement Street',    '801 Clement St, SF',     -122.4675, 37.7832, 2),
(4, 'Walgreens Mission District', '2690 Mission St, SF',    -122.4200, 37.7503, 1),
(5, 'CVS Market Street',          '2101 Market St, SF',     -122.4340, 37.7673, 2),
(6, 'Walgreens Divisadero',       '3201 Divisadero St, SF', -122.4431, 37.7925, 2);

-- =============================================================================
-- TOOL_SUPPLY_CHAIN: End-to-end pharmaceutical supply chain optimisation
-- Flow: load pharmacies → compute demand from catchment morbidity → generate
--       VROOM jobs with skills → optimise routes for 3 specialist vehicles
-- =============================================================================

CREATE OR REPLACE PROCEDURE FLEET_INTELLIGENCE.ROUTING_AGENT.TOOL_SUPPLY_CHAIN(
    PROFILE VARCHAR DEFAULT 'driving-car'
)
RETURNS VARIANT
LANGUAGE JAVASCRIPT
AS
$$
try {
    var depotLon = -122.3946;
    var depotLat = 37.7941;
    var depotName = 'SF Medical Supply Depot, 1 Market St';

    // Step 1: Load pharmacies
    var pharmaStmt = snowflake.createStatement({
        sqlText: "SELECT PHARMACY_ID, NAME, ADDRESS, LONGITUDE, LATITUDE, PRIORITY " +
                 "FROM FLEET_INTELLIGENCE.ROUTE_OPTIMIZATION.SF_TOP_PHARMACIES ORDER BY PRIORITY"
    });
    var pharmaRes = pharmaStmt.execute();
    var pharmacies = [];
    while (pharmaRes.next()) {
        pharmacies.push({
            id: pharmaRes.getColumnValue(1),
            name: pharmaRes.getColumnValue(2),
            address: pharmaRes.getColumnValue(3),
            longitude: pharmaRes.getColumnValue(4),
            latitude: pharmaRes.getColumnValue(5),
            priority: pharmaRes.getColumnValue(6)
        });
    }

    // Step 2: Load drug formulary
    var drugStmt = snowflake.createStatement({
        sqlText: "SELECT DRUG_ID, CONDITION, DRUG_NAME, DRUG_CATEGORY, DELIVERY_SKILL, " +
                 "SKILL_LABEL, UNITS_PER_1000, PRIORITY " +
                 "FROM FLEET_INTELLIGENCE.ROUTE_OPTIMIZATION.SF_DRUG_FORMULARY ORDER BY PRIORITY"
    });
    var drugRes = drugStmt.execute();
    var formulary = [];
    while (drugRes.next()) {
        formulary.push({
            drug_id: drugRes.getColumnValue(1),
            condition: drugRes.getColumnValue(2),
            drug_name: drugRes.getColumnValue(3),
            drug_category: drugRes.getColumnValue(4),
            delivery_skill: drugRes.getColumnValue(5),
            skill_label: drugRes.getColumnValue(6),
            units_per_1000: drugRes.getColumnValue(7),
            priority: drugRes.getColumnValue(8)
        });
    }

    // Step 3: For each pharmacy, compute demand based on nearby demographics
    var demoStmt = snowflake.createStatement({
        sqlText: "SELECT NEIGHBORHOOD, TOTAL_POPULATION, DIABETES_PCT, HYPERTENSION_PCT, " +
                 "CARDIOVASCULAR_PCT, RESPIRATORY_PCT, MOBILITY_ISSUES_PCT " +
                 "FROM FLEET_INTELLIGENCE.ROUTE_OPTIMIZATION.SF_HEALTH_DEMOGRAPHICS"
    });
    var demoRes = demoStmt.execute();
    var totalDiabetes = 0, totalHypertension = 0, totalCardio = 0, totalResp = 0, totalMobility = 0, totalPop = 0;
    while (demoRes.next()) {
        var pop = demoRes.getColumnValue(2);
        totalPop += pop;
        totalDiabetes += demoRes.getColumnValue(3) * pop / 100;
        totalHypertension += demoRes.getColumnValue(4) * pop / 100;
        totalCardio += demoRes.getColumnValue(5) * pop / 100;
        totalResp += demoRes.getColumnValue(6) * pop / 100;
        totalMobility += demoRes.getColumnValue(7) * pop / 100;
    }

    // Distribute demand across pharmacies proportionally (high priority gets more)
    var priorityWeights = { 1: 0.25, 2: 0.15, 3: 0.10 };
    var vroomJobs = [];
    var jobDetails = [];
    var jobId = 1;

    for (var p = 0; p < pharmacies.length; p++) {
        var pharmacy = pharmacies[p];
        var weight = priorityWeights[pharmacy.priority] || 0.10;

        // Determine top drugs for this pharmacy based on population health
        var conditions = {
            'DIABETES': totalDiabetes * weight,
            'HYPERTENSION': totalHypertension * weight,
            'CARDIOVASCULAR': totalCardio * weight,
            'RESPIRATORY': totalResp * weight,
            'MOBILITY': totalMobility * weight
        };

        // Pick top 5 drugs by estimated units for this pharmacy
        var pharmaOrders = [];
        for (var d = 0; d < formulary.length; d++) {
            var drug = formulary[d];
            var condPop = conditions[drug.condition] || 0;
            var units = Math.round(condPop / 1000 * drug.units_per_1000);
            if (units > 0) {
                pharmaOrders.push({
                    drug_name: drug.drug_name,
                    drug_category: drug.drug_category,
                    skill: drug.delivery_skill,
                    skill_label: drug.skill_label,
                    units: units,
                    priority: drug.priority
                });
            }
        }
        pharmaOrders.sort(function(a, b) { return a.priority - b.priority || b.units - a.units; });
        var topOrders = pharmaOrders.slice(0, 5);

        // Create one VROOM job per delivery to this pharmacy
        // Group by skill to determine which vehicle handles it
        var skillGroups = {};
        for (var o = 0; o < topOrders.length; o++) {
            var sk = topOrders[o].skill;
            if (!skillGroups[sk]) skillGroups[sk] = { skill: sk, skill_label: topOrders[o].skill_label, drugs: [], total_units: 0 };
            skillGroups[sk].drugs.push(topOrders[o].drug_name);
            skillGroups[sk].total_units += topOrders[o].units;
        }

        for (var sk in skillGroups) {
            var group = skillGroups[sk];
            vroomJobs.push({
                id: jobId,
                location: [pharmacy.longitude, pharmacy.latitude],
                amount: [1],
                skills: [Number(sk)],
                description: pharmacy.name + ' - ' + group.skill_label + ': ' + group.drugs.join(', ')
            });
            jobDetails.push({
                job_id: jobId,
                pharmacy: pharmacy.name,
                address: pharmacy.address,
                longitude: pharmacy.longitude,
                latitude: pharmacy.latitude,
                skill: Number(sk),
                skill_label: group.skill_label,
                drugs: group.drugs,
                total_units: group.total_units
            });
            jobId++;
        }
    }

    // Step 4: 3 specialist vehicles
    var vehicles = [
        { id: 1, start: [depotLon, depotLat], end: [depotLon, depotLat],
          profile: PROFILE, capacity: [vroomJobs.length], skills: [1],
          description: 'Cold Chain Van (Insulin, Biologics, Nitroglycerin)' },
        { id: 2, start: [depotLon, depotLat], end: [depotLon, depotLat],
          profile: PROFILE, capacity: [vroomJobs.length], skills: [2],
          description: 'Controlled Substances Van (Opioids, Anticoagulants, Steroids)' },
        { id: 3, start: [depotLon, depotLat], end: [depotLon, depotLat],
          profile: PROFILE, capacity: [vroomJobs.length], skills: [3],
          description: 'Standard Delivery Van (Oral medications, Inhalers, Topicals)' }
    ];

    // Step 5: Call VROOM optimisation
    var vroomPayload = JSON.stringify({ jobs: vroomJobs, vehicles: vehicles });
    var optSQL = "SELECT o.RESPONSE, ST_ASGEOJSON(o.GEOJSON) AS GEOJSON " +
                 "FROM TABLE(OPENROUTESERVICE_APP.CORE.OPTIMIZATION(PARSE_JSON(?), ?)) o LIMIT 1";
    var optStmt = snowflake.createStatement({ sqlText: optSQL, binds: [vroomPayload, PROFILE] });
    var optRes = optStmt.execute();

    if (!optRes.next()) {
        return { error: 'OPTIMIZATION returned no results', status: 'FAILED', jobs: jobDetails };
    }

    var rawResp = optRes.getColumnValue(1);
    var response = (typeof rawResp === 'string') ? JSON.parse(rawResp || '{}') : (rawResp || {});
    var geojsonRaw = optRes.getColumnValue(2);
    var geojson = geojsonRaw ? ((typeof geojsonRaw === 'string') ? JSON.parse(geojsonRaw) : geojsonRaw) : null;

    // Build summary
    var skill1Jobs = jobDetails.filter(function(j) { return j.skill === 1; });
    var skill2Jobs = jobDetails.filter(function(j) { return j.skill === 2; });
    var skill3Jobs = jobDetails.filter(function(j) { return j.skill === 3; });

    return {
        status: 'SUCCESS',
        num_vehicles: 3,
        total_jobs: vroomJobs.length,
        pharmacies_served: pharmacies.length,
        jobs: jobDetails,
        vehicles: vehicles,
        routes: response.routes || [],
        unassigned: response.unassigned || [],
        depot: { longitude: depotLon, latitude: depotLat, name: depotName },
        geometry: geojson,
        demand_summary: {
            cold_chain_stops: skill1Jobs.length,
            controlled_substance_stops: skill2Jobs.length,
            standard_medicine_stops: skill3Jobs.length,
            cold_chain_drugs: skill1Jobs.map(function(j) { return j.drugs; }).reduce(function(a, b) { return a.concat(b); }, []),
            controlled_drugs: skill2Jobs.map(function(j) { return j.drugs; }).reduce(function(a, b) { return a.concat(b); }, []),
            standard_drugs: skill3Jobs.map(function(j) { return j.drugs; }).reduce(function(a, b) { return a.concat(b); }, [])
        },
        population_basis: {
            total_population: totalPop,
            diabetes_patients: Math.round(totalDiabetes),
            hypertension_patients: Math.round(totalHypertension),
            cardiovascular_patients: Math.round(totalCardio),
            respiratory_patients: Math.round(totalResp),
            mobility_patients: Math.round(totalMobility)
        }
    };
} catch(err) {
    return { error: err.message, status: 'FAILED' };
}
$$;

SELECT 'Supply chain demo objects created successfully' AS STATUS;

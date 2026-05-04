-- =============================================================================
-- SF PHARMA DELIVERY DEMO DATA
-- Pre-geocoded San Francisco pharmacy/medical delivery stops with VROOM skills:
--   Skill 1 = Cold chain / vaccine delivery (refrigerated van)
--   Skill 2 = Controlled substance delivery (pharmacist-staffed van)
--   Skill 3 = Standard medicine delivery (general van)
-- =============================================================================

USE WAREHOUSE ROUTING_ANALYTICS;
USE DATABASE FLEET_INTELLIGENCE;

CREATE SCHEMA IF NOT EXISTS ROUTE_OPTIMIZATION;

CREATE OR REPLACE TABLE FLEET_INTELLIGENCE.ROUTE_OPTIMIZATION.SF_PHARMA_JOBS (
    JOB_ID      NUMBER,
    NAME        VARCHAR,
    ADDRESS     VARCHAR,
    LONGITUDE   FLOAT,
    LATITUDE    FLOAT,
    SKILL       NUMBER,
    SKILL_LABEL VARCHAR,
    AMOUNT      NUMBER DEFAULT 1
);

INSERT INTO FLEET_INTELLIGENCE.ROUTE_OPTIMIZATION.SF_PHARMA_JOBS VALUES
-- Skill 1: Cold Chain / Vaccine Delivery (refrigerated van required)
(1,  'UCSF Parnassus Vaccination Centre', '505 Parnassus Ave, SF',       -122.4584, 37.7630, 1, 'Cold Chain / Vaccines', 1),
(2,  'Kaiser Permanente Geary',            '2425 Geary Blvd, SF',         -122.4440, 37.7819, 1, 'Cold Chain / Vaccines', 1),
(3,  'Zuckerberg SF General Hospital',     '1001 Potrero Ave, SF',         -122.4064, 37.7553, 1, 'Cold Chain / Vaccines', 1),
(4,  'SF VA Medical Center',               '4150 Clement St, SF',          -122.4987, 37.7832, 1, 'Cold Chain / Vaccines', 1),
(5,  'Chinese Hospital Clinic',            '845 Jackson St, SF',           -122.4073, 37.7956, 1, 'Cold Chain / Vaccines', 1),
(6,  'St Mary''s Medical Center',          '450 Stanyan St, SF',           -122.4462, 37.7726, 1, 'Cold Chain / Vaccines', 1),
(7,  'Castro-Davies Medical Center',       '45 Castro St, SF',             -122.4350, 37.7676, 1, 'Cold Chain / Vaccines', 1),
(8,  'Excelsior Health Clinic',            '4921 Mission St, SF',          -122.4374, 37.7222, 1, 'Cold Chain / Vaccines', 1),
(9,  'Bayview Child Health Center',        '3801 3rd St, SF',              -122.3900, 37.7407, 1, 'Cold Chain / Vaccines', 1),
(10, 'Tenderloin Health Clinic',           '311 Turk St, SF',              -122.4175, 37.7820, 1, 'Cold Chain / Vaccines', 1),

-- Skill 2: Controlled Substance Delivery (licensed pharmacist van)
(11, 'Walgreens Castro',                   '498 Castro St, SF',            -122.4312, 37.7616, 2, 'Controlled Substances', 1),
(12, 'CVS Geary Boulevard',                '2676 Geary Blvd, SF',          -122.4506, 37.7798, 2, 'Controlled Substances', 1),
(13, 'Walgreens Divisadero',               '3201 Divisadero St, SF',       -122.4431, 37.7925, 2, 'Controlled Substances', 1),
(14, 'CVS Sacramento Street',              '3700 Sacramento St, SF',       -122.4531, 37.7875, 2, 'Controlled Substances', 1),
(15, 'Rite Aid Clement Street',            '801 Clement St, SF',           -122.4675, 37.7832, 2, 'Controlled Substances', 1),
(16, 'Walgreens Mission District',         '2690 Mission St, SF',          -122.4200, 37.7503, 2, 'Controlled Substances', 1),
(17, 'CVS Market Street',                  '2101 Market St, SF',           -122.4340, 37.7673, 2, 'Controlled Substances', 1),
(18, 'Walgreens Haight Street',            '1301 Haight St, SF',           -122.4465, 37.7695, 2, 'Controlled Substances', 1),
(19, 'Rite Aid Taraval',                   '3701 Taraval St, SF',          -122.4842, 37.7422, 2, 'Controlled Substances', 1),
(20, 'Walgreens Noe Valley',               '4278 24th St, SF',             -122.4334, 37.7507, 2, 'Controlled Substances', 1),

-- Skill 3: Standard Medicine Delivery (general delivery van)
(21, 'Marina Medical Group',               '3100 Scott St, SF',            -122.4426, 37.8010, 3, 'Standard Medicines',    1),
(22, 'North Beach Family Medicine',        '620 Columbus Ave, SF',         -122.4094, 37.7989, 3, 'Standard Medicines',    1),
(23, 'Haight Ashbury Free Clinic',         '558 Clayton St, SF',           -122.4476, 37.7687, 3, 'Standard Medicines',    1),
(24, 'Richmond District Medical',          '6239 Geary Blvd, SF',          -122.4842, 37.7803, 3, 'Standard Medicines',    1),
(25, 'Sunset Medical Center',              '3111 Taraval St, SF',          -122.4782, 37.7452, 3, 'Standard Medicines',    1),
(26, 'Inner Sunset GP Practice',           '1709 Irving St, SF',           -122.4723, 37.7634, 3, 'Standard Medicines',    1),
(27, 'Mission District Health Center',     '3555 22nd St, SF',             -122.4232, 37.7540, 3, 'Standard Medicines',    1),
(28, 'South Beach Pharmacy',               '400 Beale St, SF',             -122.3899, 37.7887, 3, 'Standard Medicines',    1),
(29, 'Dogpatch Medical Clinic',            '2468 3rd St, SF',              -122.3890, 37.7587, 3, 'Standard Medicines',    1),
(30, 'FiDi Corporate Health',              '580 California St, SF',        -122.4017, 37.7931, 3, 'Standard Medicines',    1);

-- =============================================================================
-- TOOL_PHARMA_OPTIMIZATION: Demo optimisation using pre-geocoded pharma jobs
-- Forces 3 vehicles via VROOM skills (each vehicle only handles its skill type)
-- =============================================================================

CREATE OR REPLACE PROCEDURE FLEET_INTELLIGENCE.ROUTING_AGENT.TOOL_PHARMA_OPTIMIZATION(
    PROFILE VARCHAR DEFAULT 'driving-car'
)
RETURNS VARIANT
LANGUAGE JAVASCRIPT
AS
$$
try {
    // Depot: SF Medical Supply Depot at 1 Market Street
    var depotLon = -122.3946;
    var depotLat =  37.7941;

    // Load pre-geocoded jobs from table
    var jobsStmt = snowflake.createStatement({
        sqlText: "SELECT JOB_ID, NAME, ADDRESS, LONGITUDE, LATITUDE, SKILL, SKILL_LABEL, AMOUNT " +
                 "FROM FLEET_INTELLIGENCE.ROUTE_OPTIMIZATION.SF_PHARMA_JOBS ORDER BY JOB_ID"
    });
    var jobsRes = jobsStmt.execute();

    var vroomJobs = [];
    var jobMeta = [];
    while (jobsRes.next()) {
        var id       = jobsRes.getColumnValue(1);
        var name     = jobsRes.getColumnValue(2);
        var address  = jobsRes.getColumnValue(3);
        var lon      = jobsRes.getColumnValue(4);
        var lat      = jobsRes.getColumnValue(5);
        var skill    = jobsRes.getColumnValue(6);
        var skillLbl = jobsRes.getColumnValue(7);
        var amount   = jobsRes.getColumnValue(8);
        vroomJobs.push({ id: id, location: [lon, lat], amount: [amount], skills: [skill], description: name });
        jobMeta.push({ name: name, address: address, longitude: lon, latitude: lat, skill: skill, skill_label: skillLbl });
    }

    if (vroomJobs.length === 0) {
        return { error: 'No jobs found in SF_PHARMA_JOBS table', status: 'FAILED' };
    }

    // 3 vehicles - each with a single exclusive skill to guarantee all 3 are used
    var vehicles = [
        { id: 1, start: [depotLon, depotLat], end: [depotLon, depotLat],
          profile: PROFILE, capacity: [12], skills: [1],
          description: 'Cold Chain Van (Vaccines & Refrigerated)' },
        { id: 2, start: [depotLon, depotLat], end: [depotLon, depotLat],
          profile: PROFILE, capacity: [12], skills: [2],
          description: 'Controlled Substances Van (Licensed Pharmacist)' },
        { id: 3, start: [depotLon, depotLat], end: [depotLon, depotLat],
          profile: PROFILE, capacity: [12], skills: [3],
          description: 'Standard Delivery Van' }
    ];

    var vroomPayload = JSON.stringify({ jobs: vroomJobs, vehicles: vehicles });

    var optSQL = "SELECT o.RESPONSE, ST_ASGEOJSON(o.GEOJSON) AS GEOJSON " +
                 "FROM TABLE(OPENROUTESERVICE_APP.CORE.OPTIMIZATION(PARSE_JSON(?), ?)) o LIMIT 1";
    var optStmt = snowflake.createStatement({ sqlText: optSQL, binds: [vroomPayload, PROFILE] });
    var optRes = optStmt.execute();

    if (!optRes.next()) {
        return { error: 'OPTIMIZATION returned no results', status: 'FAILED' };
    }

    var rawResp  = optRes.getColumnValue(1);
    var response = (typeof rawResp === 'string') ? JSON.parse(rawResp || '{}') : (rawResp || {});
    var geojsonRaw = optRes.getColumnValue(2);
    var geojson  = geojsonRaw ? ((typeof geojsonRaw === 'string') ? JSON.parse(geojsonRaw) : geojsonRaw) : null;

    return {
        status:      'SUCCESS',
        num_vehicles: 3,
        jobs:         jobMeta,
        vehicles:     vehicles,
        routes:       response.routes || [],
        unassigned:   response.unassigned || [],
        summary:      response.summary || {},
        depot: { longitude: depotLon, latitude: depotLat, name: 'SF Medical Supply Depot, 1 Market St' },
        geometry:     geojson
    };
} catch(err) {
    return { error: err.message, status: 'FAILED' };
}
$$;

SELECT 'SF Pharma demo data and procedure created successfully' AS STATUS;

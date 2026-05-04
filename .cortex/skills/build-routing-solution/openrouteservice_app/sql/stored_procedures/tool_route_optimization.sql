CREATE OR REPLACE PROCEDURE FLEET_INTELLIGENCE.ROUTING_AGENT.TOOL_ROUTE_OPTIMIZATION(
    DESCRIPTION VARCHAR,
    NUM_VEHICLES FLOAT DEFAULT 1,
    PROFILE VARCHAR DEFAULT 'driving-car'
)
RETURNS VARIANT
LANGUAGE JAVASCRIPT
AS
$$
try {
    var geocodeSQL = "SELECT AI_COMPLETE(" +
        "'claude-sonnet-4-5'," +
        "CONCAT('Parse this routing problem into separate lists for jobs (deliveries/stops) and vehicles (start/end points). Use worldwide lat/lon coordinates. Description: ', ?)," +
        "{'temperature': 0, 'max_tokens': 3000}," +
        "{'type': 'json', 'schema': {'type': 'object', 'properties': {" +
            "'jobs': {'type': 'array', 'items': {'type': 'object', 'properties': {'name': {'type': 'string'}, 'longitude': {'type': 'number'}, 'latitude': {'type': 'number'}}, 'required': ['name', 'longitude', 'latitude']}}," +
            "'vehicles': {'type': 'array', 'items': {'type': 'object', 'properties': {'name': {'type': 'string'}, 'start_longitude': {'type': 'number'}, 'start_latitude': {'type': 'number'}, 'end_longitude': {'type': 'number'}, 'end_latitude': {'type': 'number'}}, 'required': ['name', 'start_longitude', 'start_latitude', 'end_longitude', 'end_latitude']}}" +
        "}, 'required': ['jobs', 'vehicles']}}" +
        ") AS result";

    var geocodeStmt = snowflake.createStatement({ sqlText: geocodeSQL, binds: [DESCRIPTION] });
    var geocodeRes = geocodeStmt.execute();
    geocodeRes.next();
    var raw = geocodeRes.getColumnValue(1);
    var geocoded = (typeof raw === 'string') ? JSON.parse(raw) : raw;

    if (!geocoded.jobs || geocoded.jobs.length === 0) {
        return { error: 'Geocoding returned no jobs', status: 'FAILED' };
    }
    if (!geocoded.vehicles || geocoded.vehicles.length === 0) {
        return { error: 'Geocoding returned no vehicles', status: 'FAILED' };
    }

    // Build VROOM-format payload
    var jobs = geocoded.jobs.map(function(j, i) {
        return { id: i + 1, location: [j.longitude, j.latitude], amount: [1], description: j.name };
    });
    var vehicles = geocoded.vehicles.map(function(v, i) {
        return {
            id: i + 1,
            start: [v.start_longitude, v.start_latitude],
            end: [v.end_longitude, v.end_latitude],
            profile: PROFILE,
            capacity: [jobs.length]
        };
    });
    var vroomPayload = JSON.stringify({ jobs: jobs, vehicles: vehicles });

    var optSQL = "SELECT o.RESPONSE, ST_ASGEOJSON(o.GEOJSON) AS GEOJSON " +
                 "FROM TABLE(OPENROUTESERVICE_APP.CORE.OPTIMIZATION(PARSE_JSON(?), ?)) o LIMIT 1";
    var optStmt = snowflake.createStatement({ sqlText: optSQL, binds: [vroomPayload, PROFILE] });
    var optRes = optStmt.execute();

    if (!optRes.next()) {
        return { error: 'OPTIMIZATION returned no results', status: 'FAILED', jobs: geocoded.jobs, vehicles: geocoded.vehicles };
    }

    var rawResp = optRes.getColumnValue(1);
    var response = (typeof rawResp === 'string') ? JSON.parse(rawResp || '{}') : (rawResp || {});
    var geojsonRaw = optRes.getColumnValue(2);
    var geojson = geojsonRaw ? ((typeof geojsonRaw === 'string') ? JSON.parse(geojsonRaw) : geojsonRaw) : null;

    if (response.code && response.code !== 0) {
        return { error: 'VROOM error: ' + JSON.stringify(response), status: 'FAILED' };
    }

    return {
        status: 'SUCCESS',
        num_vehicles: geocoded.vehicles.length,
        jobs: geocoded.jobs,
        vehicles: geocoded.vehicles,
        routes: response.routes || [],
        depot: geocoded.vehicles[0] ? {
            longitude: geocoded.vehicles[0].start_longitude,
            latitude: geocoded.vehicles[0].start_latitude,
            name: geocoded.vehicles[0].name
        } : null,
        geometry: geojson
    };
} catch(err) {
    return { error: err.message, status: 'FAILED' };
}
$$;

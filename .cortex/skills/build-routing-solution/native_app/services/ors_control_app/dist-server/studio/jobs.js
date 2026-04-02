import { createRng, uuid, resolveVehicleType } from './profiles.js';
import { generateTelemetry } from './engine.js';
const activeJobs = new Map();
export function getJobs() {
    return [...activeJobs.values()].map(j => ({ ...j, abort: undefined, listeners: undefined }));
}
export function getJob(jobId) {
    return activeJobs.get(jobId);
}
export function cancelJob(jobId) {
    const job = activeJobs.get(jobId);
    if (!job || job.status !== 'RUNNING')
        return false;
    job.abort.aborted = true;
    job.status = 'CANCELLED';
    job.completedAt = new Date();
    broadcast(job, 'cancelled', { jobId });
    return true;
}
function broadcast(job, event, data) {
    for (const cb of job.listeners) {
        try {
            cb(event, data);
        }
        catch { }
    }
}
export function subscribeJob(jobId, cb) {
    const job = activeJobs.get(jobId);
    if (!job)
        return () => { };
    job.listeners.add(cb);
    return () => { job.listeners.delete(cb); };
}
function escVal(v) {
    if (v === null || v === undefined)
        return 'NULL';
    if (typeof v === 'boolean')
        return v ? 'TRUE' : 'FALSE';
    if (typeof v === 'number')
        return String(v);
    if (v instanceof Date)
        return `'${v.toISOString().replace('T', ' ').replace('Z', '')}'`;
    return `'${String(v).replace(/'/g, "''")}'`;
}
const UNIFIED_DB = 'SYNTHETIC_DATASETS';
const UNIFIED_SCHEMA = 'UNIFIED';
async function ensureTables(snowSql) {
    const ddls = [
        `CREATE TABLE IF NOT EXISTS ${UNIFIED_DB}.${UNIFIED_SCHEMA}.FACT_VEHICLE_TELEMETRY (
      TELEMETRY_ID VARCHAR, REGION VARCHAR(100), VEHICLE_TYPE VARCHAR(20),
      VEHICLE_ID VARCHAR, TRIP_ID VARCHAR,
      TS TIMESTAMP_NTZ, LATITUDE FLOAT, LONGITUDE FLOAT,
      SPEED_KMH FLOAT, HEADING_DEG FLOAT, POSTED_SPEED_KMH FLOAT,
      STATUS VARCHAR(30), IS_SPEEDING BOOLEAN, IS_HOS_VIOLATION BOOLEAN, IS_DETOUR BOOLEAN,
      GPS_ACCURACY_M FLOAT, LOCATION_ID VARCHAR, LOCATION_TYPE VARCHAR(30),
      ORS_PROFILE VARCHAR(30), BATTERY_PCT FLOAT, ODOMETER_KM FLOAT, POINT_INDEX INT
    )`,
        `CREATE TABLE IF NOT EXISTS ${UNIFIED_DB}.${UNIFIED_SCHEMA}.FACT_TRIPS (
      TRIP_ID VARCHAR, VEHICLE_ID VARCHAR, DRIVER_ID VARCHAR,
      VEHICLE_TYPE VARCHAR(20), REGION VARCHAR(100),
      ORIGIN_POI_ID VARCHAR, DESTINATION_POI_ID VARCHAR,
      ORIGIN_LAT FLOAT, ORIGIN_LON FLOAT,
      DESTINATION_LAT FLOAT, DESTINATION_LON FLOAT,
      ROUTE_GEOG GEOGRAPHY, DISTANCE_KM FLOAT, DURATION_MINUTES FLOAT,
      PLANNED_ROUTE_GEOG GEOGRAPHY, PLANNED_DISTANCE_KM FLOAT,
      IS_DETOUR BOOLEAN, DETOUR_DISTANCE_KM FLOAT,
      TRIP_START TIMESTAMP_NTZ, TRIP_END TIMESTAMP_NTZ,
      STATUS VARCHAR(20), ORS_PROFILE VARCHAR(30)
    )`,
        `CREATE TABLE IF NOT EXISTS ${UNIFIED_DB}.${UNIFIED_SCHEMA}.DIM_FLEET (
      VEHICLE_ID VARCHAR, REGION VARCHAR(100), VEHICLE_TYPE VARCHAR(20),
      ORS_PROFILE VARCHAR(30), SHIFT_TYPE VARCHAR(30),
      SHIFT_START_HOUR INT, SHIFT_END_HOUR INT,
      HOME_LOCATION_ID VARCHAR, DRIVER_PROFILE VARCHAR(20),
      OPERATING_MODE VARCHAR(30), BASE_SPEED_KMH FLOAT, BATTERY_RANGE_KM FLOAT
    )`,
        `CREATE TABLE IF NOT EXISTS ${UNIFIED_DB}.${UNIFIED_SCHEMA}.DIM_POIS (
      LOCATION_ID VARCHAR, REGION VARCHAR(100), NAME VARCHAR,
      LOCATION_TYPE VARCHAR(30), CATEGORY VARCHAR(50),
      LAT FLOAT, LNG FLOAT, POINT_GEOM GEOGRAPHY, SOURCE VARCHAR(20)
    )`,
        `CREATE TABLE IF NOT EXISTS ${UNIFIED_DB}.${UNIFIED_SCHEMA}.DIM_TRIP_SCHEDULE (
      SCHEDULE_ID VARCHAR, VEHICLE_ID VARCHAR, DRIVER_ID VARCHAR,
      VEHICLE_TYPE VARCHAR(20), REGION VARCHAR(100),
      TRIP_DATE DATE, TRIP_SEQ INT,
      ORIGIN_POI_ID VARCHAR, DESTINATION_POI_ID VARCHAR,
      PLANNED_START TIMESTAMP_NTZ, PLANNED_END TIMESTAMP_NTZ,
      SHIFT_TYPE VARCHAR(30), ORS_PROFILE VARCHAR(30),
      DISTANCE_KM FLOAT, DURATION_MINUTES FLOAT, STATUS VARCHAR(20)
    )`,
    ];
    for (const ddl of ddls) {
        try {
            await snowSql(ddl, UNIFIED_DB, UNIFIED_SCHEMA);
        }
        catch (e) {
            console.error(`[Studio] DDL error: ${e.message?.slice(0, 200)}`);
        }
    }
}
async function insertTelemetryBatch(points, snowSql) {
    if (points.length === 0)
        return 0;
    const batchSize = 500;
    let inserted = 0;
    for (let i = 0; i < points.length; i += batchSize) {
        const chunk = points.slice(i, i + batchSize);
        const values = chunk.map(p => `(${escVal(p.telemetry_id)},${escVal(p.region)},${escVal(p.vehicle_type)},` +
            `${escVal(p.vehicle_id)},${escVal(p.trip_id)},` +
            `${escVal(p.ts)},${p.latitude},${p.longitude},${p.speed_kmh},${p.heading_deg},` +
            `${p.posted_speed_kmh},${escVal(p.status)},${escVal(p.is_speeding)},${escVal(p.is_hos_violation)},` +
            `${escVal(p.is_detour)},${p.gps_accuracy_m},${escVal(p.location_id)},${escVal(p.location_type)},` +
            `${escVal(p.ors_profile)},${p.battery_pct !== null ? p.battery_pct : 'NULL'},` +
            `${p.odometer_km !== null ? p.odometer_km : 'NULL'},${p.point_index !== null ? p.point_index : 'NULL'})`).join(',\n');
        const sql = `INSERT INTO ${UNIFIED_DB}.${UNIFIED_SCHEMA}.FACT_VEHICLE_TELEMETRY
      (TELEMETRY_ID,REGION,VEHICLE_TYPE,VEHICLE_ID,TRIP_ID,TS,LATITUDE,LONGITUDE,SPEED_KMH,HEADING_DEG,
       POSTED_SPEED_KMH,STATUS,IS_SPEEDING,IS_HOS_VIOLATION,IS_DETOUR,GPS_ACCURACY_M,
       LOCATION_ID,LOCATION_TYPE,ORS_PROFILE,BATTERY_PCT,ODOMETER_KM,POINT_INDEX)
      VALUES ${values}`;
        try {
            await snowSql(sql, UNIFIED_DB, UNIFIED_SCHEMA);
            inserted += chunk.length;
        }
        catch (e) {
            console.error(`[Studio] Telemetry insert error: ${e.message?.slice(0, 200)}`);
        }
    }
    return inserted;
}
async function insertTripBatch(trips, snowSql) {
    if (trips.length === 0)
        return 0;
    const batchSize = 200;
    let inserted = 0;
    for (let i = 0; i < trips.length; i += batchSize) {
        const chunk = trips.slice(i, i + batchSize);
        const values = chunk.map(t => {
            const routeGeo = t.route_coordinates.length >= 2
                ? `TO_GEOGRAPHY('LINESTRING(${t.route_coordinates.map(c => `${c[1]} ${c[0]}`).join(',')})')`
                : 'NULL';
            const plannedGeo = t.planned_route_coordinates && t.planned_route_coordinates.length >= 2
                ? `TO_GEOGRAPHY('LINESTRING(${t.planned_route_coordinates.map(c => `${c[1]} ${c[0]}`).join(',')})')`
                : 'NULL';
            return `(${escVal(t.trip_id)},${escVal(t.vehicle_id)},${escVal(t.driver_id)},` +
                `${escVal(t.vehicle_type)},${escVal(t.region)},` +
                `${escVal(t.origin_poi_id)},${escVal(t.destination_poi_id)},` +
                `${t.origin_lat},${t.origin_lon},${t.destination_lat},${t.destination_lon},` +
                `${routeGeo},${t.distance_km},${t.duration_minutes},` +
                `${plannedGeo},${t.planned_distance_km !== null ? t.planned_distance_km : 'NULL'},` +
                `${escVal(t.is_detour)},${t.detour_distance_km !== null ? t.detour_distance_km : 'NULL'},` +
                `${escVal(t.trip_start)},${escVal(t.trip_end)},${escVal(t.status)},${escVal(t.ors_profile)})`;
        }).join(',\n');
        const sql = `INSERT INTO ${UNIFIED_DB}.${UNIFIED_SCHEMA}.FACT_TRIPS
      (TRIP_ID,VEHICLE_ID,DRIVER_ID,VEHICLE_TYPE,REGION,
       ORIGIN_POI_ID,DESTINATION_POI_ID,ORIGIN_LAT,ORIGIN_LON,DESTINATION_LAT,DESTINATION_LON,
       ROUTE_GEOG,DISTANCE_KM,DURATION_MINUTES,
       PLANNED_ROUTE_GEOG,PLANNED_DISTANCE_KM,
       IS_DETOUR,DETOUR_DISTANCE_KM,TRIP_START,TRIP_END,STATUS,ORS_PROFILE)
      VALUES ${values}`;
        try {
            await snowSql(sql, UNIFIED_DB, UNIFIED_SCHEMA);
            inserted += chunk.length;
        }
        catch (e) {
            console.error(`[Studio] Trip insert error: ${e.message?.slice(0, 200)}`);
        }
    }
    return inserted;
}
async function insertDimFleet(fleet, config, snowSql) {
    if (fleet.length === 0)
        return;
    const vt = resolveVehicleType(config);
    const values = fleet.map((m) => `(${escVal(m.vehicle_id)},${escVal(config.region)},${escVal(vt)},${escVal(config.ors_profile)},` +
        `${escVal(m.shift_start + '-' + m.shift_end)},${m.shift_start},${m.shift_end},` +
        `${escVal(m.home_poi.location_id)},${escVal(m.profile_type)},${escVal(config.mode)},` +
        `${m.base_speed_kmh},${m.battery_pct > 0 ? config.battery?.range_km || 'NULL' : 'NULL'})`).join(',\n');
    const sql = `INSERT INTO ${UNIFIED_DB}.${UNIFIED_SCHEMA}.DIM_FLEET
    (VEHICLE_ID,REGION,VEHICLE_TYPE,ORS_PROFILE,SHIFT_TYPE,SHIFT_START_HOUR,SHIFT_END_HOUR,
     HOME_LOCATION_ID,DRIVER_PROFILE,OPERATING_MODE,BASE_SPEED_KMH,BATTERY_RANGE_KM)
    VALUES ${values}`;
    try {
        await snowSql(sql, UNIFIED_DB, UNIFIED_SCHEMA);
    }
    catch (e) {
        console.error(`[Studio] DIM_FLEET insert error: ${e.message?.slice(0, 200)}`);
    }
}
async function insertDimPois(pois, config, snowSql) {
    if (pois.length === 0)
        return;
    const batchSize = 500;
    for (let i = 0; i < pois.length; i += batchSize) {
        const chunk = pois.slice(i, i + batchSize);
        const values = chunk.map((p) => `(${escVal(p.location_id)},${escVal(config.region)},${escVal(p.name)},${escVal(p.location_type)},` +
            `${escVal(p.category)},${p.lat},${p.lng},ST_MAKEPOINT(${p.lng},${p.lat}),${escVal(p.source || 'generated')})`).join(',\n');
        const sql = `INSERT INTO ${UNIFIED_DB}.${UNIFIED_SCHEMA}.DIM_POIS
      (LOCATION_ID,REGION,NAME,LOCATION_TYPE,CATEGORY,LAT,LNG,POINT_GEOM,SOURCE)
      VALUES ${values}`;
        try {
            await snowSql(sql, UNIFIED_DB, UNIFIED_SCHEMA);
        }
        catch (e) {
            console.error(`[Studio] DIM_POIS insert error: ${e.message?.slice(0, 200)}`);
        }
    }
}
export async function startGeneration(config, presetName, snowSql) {
    const rng = createRng(Date.now());
    const jobId = uuid(rng);
    const vt = resolveVehicleType(config);
    const job = {
        jobId,
        presetName,
        region: config.region,
        orsProfile: config.ors_profile,
        vehicleType: vt,
        status: 'RUNNING',
        pointsGenerated: 0,
        tripsGenerated: 0,
        startedAt: new Date(),
        completedAt: null,
        error: null,
        abort: { aborted: false },
        listeners: new Set(),
    };
    activeJobs.set(jobId, job);
    try {
        await snowSql(`INSERT INTO FLEET_INTELLIGENCE.CORE.GENERATION_JOBS (JOB_ID,PRESET_NAME,REGION,ORS_PROFILE,NUM_VEHICLES,START_DATE,END_DATE,STATUS,CONFIG)
       VALUES (${escVal(jobId)},${escVal(presetName)},${escVal(config.region)},${escVal(config.ors_profile)},
       ${config.fleet.num_vehicles},${escVal(config.time.start_date)},${escVal(config.time.end_date)},'RUNNING',
       PARSE_JSON(${escVal(JSON.stringify(config))}))`, 'FLEET_INTELLIGENCE', 'CORE');
    }
    catch { }
    (async () => {
        try {
            await ensureTables(snowSql);
            const { loadPOIs, buildFleet } = await import('./engine.js');
            const pois = await loadPOIs(config, snowSql);
            const fleet = buildFleet(config, pois, createRng(config.fleet.num_vehicles * 31));
            await insertDimPois(pois, config, snowSql);
            await insertDimFleet(fleet, config, snowSql);
            broadcast(job, 'progress', { status: `Loaded ${pois.length} POIs, built ${fleet.length} vehicles` });
            const pendingTrips = [];
            let stoppedEvent = null;
            const gen = generateTelemetry(config, snowSql, (p) => {
                job.pointsGenerated = p.totalPoints;
                job.tripsGenerated = p.totalTrips;
                broadcast(job, 'progress', p);
            }, job.abort);
            for await (const event of gen) {
                if (job.abort.aborted)
                    break;
                if (event.type === 'telemetry') {
                    await insertTelemetryBatch(event.points, snowSql);
                    broadcast(job, 'batch', { inserted: event.points.length, total: job.pointsGenerated });
                }
                else if (event.type === 'trip') {
                    pendingTrips.push(event.record);
                    if (pendingTrips.length >= 50) {
                        await insertTripBatch(pendingTrips.splice(0), snowSql);
                    }
                }
                else if (event.type === 'stopped') {
                    stoppedEvent = event;
                    break;
                }
            }
            if (pendingTrips.length > 0) {
                await insertTripBatch(pendingTrips, snowSql);
            }
            if (stoppedEvent) {
                job.status = 'STOPPED';
                job.completedAt = new Date();
                broadcast(job, 'stopped', {
                    reason: stoppedEvent.reason,
                    pointsGenerated: job.pointsGenerated,
                    tripsGenerated: job.tripsGenerated,
                    completedDays: stoppedEvent.completedDays,
                    totalDays: stoppedEvent.totalDays,
                    routeSuccesses: stoppedEvent.routeSuccesses,
                    routeFailures: stoppedEvent.routeFailures,
                });
            }
            else {
                job.status = job.abort.aborted ? 'CANCELLED' : 'COMPLETED';
                job.completedAt = new Date();
                broadcast(job, job.status === 'COMPLETED' ? 'complete' : 'cancelled', { pointsGenerated: job.pointsGenerated, tripsGenerated: job.tripsGenerated });
            }
            try {
                const errMsg = stoppedEvent
                    ? `ORS stopped: ${stoppedEvent.reason}. ${stoppedEvent.completedDays}/${stoppedEvent.totalDays} days completed.`
                    : null;
                await snowSql(`UPDATE FLEET_INTELLIGENCE.CORE.GENERATION_JOBS SET STATUS='${job.status}',
           POINTS_GENERATED=${job.pointsGenerated}, TRIPS_GENERATED=${job.tripsGenerated},
           ${errMsg ? `ERROR_MESSAGE=${escVal(errMsg)},` : ''}
           COMPLETED_AT=CURRENT_TIMESTAMP() WHERE JOB_ID=${escVal(jobId)}`, 'FLEET_INTELLIGENCE', 'CORE');
            }
            catch { }
        }
        catch (e) {
            job.status = 'FAILED';
            job.error = e.message;
            job.completedAt = new Date();
            broadcast(job, 'error', { error: e.message });
            try {
                await snowSql(`UPDATE FLEET_INTELLIGENCE.CORE.GENERATION_JOBS SET STATUS='FAILED',
           ERROR_MESSAGE=${escVal(e.message?.slice(0, 500))},
           COMPLETED_AT=CURRENT_TIMESTAMP() WHERE JOB_ID=${escVal(jobId)}`, 'FLEET_INTELLIGENCE', 'CORE');
            }
            catch { }
        }
    })();
    return jobId;
}

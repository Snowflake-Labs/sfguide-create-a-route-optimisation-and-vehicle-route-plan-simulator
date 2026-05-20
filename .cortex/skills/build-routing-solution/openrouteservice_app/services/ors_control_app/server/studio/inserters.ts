// Studio batch inserters — write generated telemetry, trips, fleet, POIs, and
// freight offers into the SYNTHETIC_DATASETS.UNIFIED FACT/DIM tables. All
// helpers chunk into safe-size INSERTs and return inserted row counts.

import { TelemetryPoint, TripRecord } from './engine.js';
import { GenerationConfig, resolveVehicleType } from './profiles.js';
import { log } from '../diagnostics.js';
import { escVal, UNIFIED_DB, UNIFIED_SCHEMA } from './sql-helpers.js';

type SnowSqlFn = (sql: string, database?: string, schema?: string) => Promise<any[]>;

export async function insertTelemetryBatch(points: TelemetryPoint[], snowSql: SnowSqlFn, jobId: string): Promise<number> {
  if (points.length === 0) return 0;
  const batchSize = 500;
  let inserted = 0;
  for (let i = 0; i < points.length; i += batchSize) {
    const chunk = points.slice(i, i + batchSize);
    const selects = chunk.map(p =>
      `SELECT ${escVal(p.telemetry_id)},${escVal(p.region)},${escVal(p.vehicle_type)},` +
      `${escVal(p.vehicle_id)},${escVal(p.trip_id)},` +
      `${escVal(p.ts)},${p.latitude},${p.longitude},ST_MAKEPOINT(${p.longitude},${p.latitude}),` +
      `${p.speed_kmh},${p.heading_deg},` +
      `${p.posted_speed_kmh},${escVal(p.status)},${escVal(p.is_speeding)},${escVal(p.is_hos_violation)},` +
      `${escVal(p.is_detour)},${p.gps_accuracy_m},${escVal(p.location_id)},${escVal(p.location_type)},` +
      `${escVal(p.ors_profile)},${p.battery_pct !== null ? p.battery_pct : 'NULL'},` +
      `${p.odometer_km !== null ? p.odometer_km : 'NULL'},${p.point_index !== null ? p.point_index : 'NULL'},` +
      `${escVal(jobId)}`
    ).join(' UNION ALL\n');

    const sql = `INSERT INTO ${UNIFIED_DB}.${UNIFIED_SCHEMA}.FACT_VEHICLE_TELEMETRY
      (TELEMETRY_ID,REGION,VEHICLE_TYPE,VEHICLE_ID,TRIP_ID,TS,LATITUDE,LONGITUDE,POINT_GEOM,SPEED_KMH,HEADING_DEG,
       POSTED_SPEED_KMH,STATUS,IS_SPEEDING,IS_HOS_VIOLATION,IS_DETOUR,GPS_ACCURACY_M,
       LOCATION_ID,LOCATION_TYPE,ORS_PROFILE,BATTERY_PCT,ODOMETER_KM,POINT_INDEX,JOB_ID)
      ${selects}`;
    try {
      await snowSql(sql, UNIFIED_DB, UNIFIED_SCHEMA);
      inserted += chunk.length;
    } catch (e: any) {
      const msg = `Telemetry insert error (batch ${i}-${i + batchSize}): ${e.message?.slice(0, 200)}`;
      log('ERROR', 'Studio', msg);
      throw new Error(msg);
    }
  }
  return inserted;
}

export async function insertTripBatch(trips: TripRecord[], snowSql: SnowSqlFn, jobId: string): Promise<number> {
  if (trips.length === 0) return 0;
  const batchSize = 200;
  let inserted = 0;
  for (let i = 0; i < trips.length; i += batchSize) {
    const chunk = trips.slice(i, i + batchSize);
    const selects = chunk.map(t => {
      const routeGeo = t.route_coordinates.length >= 2
        ? `TO_GEOGRAPHY('LINESTRING(${t.route_coordinates.map(c => `${c[1]} ${c[0]}`).join(',')})')`
        : 'TO_GEOGRAPHY(NULL)';
      const plannedGeo = t.planned_route_coordinates && t.planned_route_coordinates.length >= 2
        ? `TO_GEOGRAPHY('LINESTRING(${t.planned_route_coordinates.map(c => `${c[1]} ${c[0]}`).join(',')})')`
        : 'TO_GEOGRAPHY(NULL)';
      return `SELECT ${escVal(t.trip_id)},${escVal(t.vehicle_id)},${escVal(t.driver_id)},` +
        `${escVal(t.vehicle_type)},${escVal(t.region)},` +
        `${escVal(t.origin_poi_id)},${escVal(t.destination_poi_id)},` +
        `${t.origin_lat},${t.origin_lon},ST_MAKEPOINT(${t.origin_lon},${t.origin_lat}),` +
        `${t.destination_lat},${t.destination_lon},ST_MAKEPOINT(${t.destination_lon},${t.destination_lat}),` +
        `${routeGeo},${t.distance_km},${t.duration_minutes},` +
        `${plannedGeo},${t.planned_distance_km !== null ? t.planned_distance_km : 'NULL'},` +
        `${escVal(t.is_detour)},${t.detour_distance_km !== null ? t.detour_distance_km : 'NULL'},` +
        `${escVal(t.trip_start)},${escVal(t.trip_end)},${escVal(t.status)},${escVal(t.ors_profile)},` +
        `${escVal(jobId)}`;
    }).join(' UNION ALL\n');

    const sql = `INSERT INTO ${UNIFIED_DB}.${UNIFIED_SCHEMA}.FACT_TRIPS
      (TRIP_ID,VEHICLE_ID,DRIVER_ID,VEHICLE_TYPE,REGION,
       ORIGIN_POI_ID,DESTINATION_POI_ID,ORIGIN_LAT,ORIGIN_LON,ORIGIN,
       DESTINATION_LAT,DESTINATION_LON,DESTINATION,
       ROUTE_GEOG,DISTANCE_KM,DURATION_MINUTES,
       PLANNED_ROUTE_GEOG,PLANNED_DISTANCE_KM,
       IS_DETOUR,DETOUR_DISTANCE_KM,TRIP_START,TRIP_END,STATUS,ORS_PROFILE,JOB_ID)
      ${selects}`;
    try {
      await snowSql(sql, UNIFIED_DB, UNIFIED_SCHEMA);
      inserted += chunk.length;
    } catch (e: any) {
      const msg = `Trip insert error (batch ${i}-${i + batchSize}): ${e.message?.slice(0, 200)}`;
      log('ERROR', 'Studio', msg);
      throw new Error(msg);
    }
  }
  return inserted;
}

export async function insertDimFleet(fleet: any[], config: GenerationConfig, snowSql: SnowSqlFn, jobId: string): Promise<void> {
  if (fleet.length === 0) return;
  const vt = resolveVehicleType(config);
  const values = fleet.map((m: any) =>
    `(${escVal(m.vehicle_id)},${escVal(config.region)},${escVal(vt)},${escVal(config.ors_profile)},` +
    `${escVal(m.shift_start + '-' + m.shift_end)},${m.shift_start},${m.shift_end},` +
    `${escVal(m.home_poi.location_id)},${escVal(m.profile_type)},${escVal(config.mode)},` +
    `${m.base_speed_kmh},${m.battery_pct > 0 ? config.battery?.range_km || 'NULL' : 'NULL'},` +
    `${escVal(jobId)})`
  ).join(',\n');
  const sql = `INSERT INTO ${UNIFIED_DB}.${UNIFIED_SCHEMA}.DIM_FLEET
    (VEHICLE_ID,REGION,VEHICLE_TYPE,ORS_PROFILE,SHIFT_TYPE,SHIFT_START_HOUR,SHIFT_END_HOUR,
     HOME_LOCATION_ID,DRIVER_PROFILE,OPERATING_MODE,BASE_SPEED_KMH,BATTERY_RANGE_KM,JOB_ID)
    VALUES ${values}`;
  try {
    await snowSql(sql, UNIFIED_DB, UNIFIED_SCHEMA);
  } catch (e: any) {
    const msg = `DIM_FLEET insert error: ${e.message?.slice(0, 200)}`;
    log('ERROR', 'Studio', msg);
    throw new Error(msg);
  }
}

export async function insertDimPois(pois: any[], config: GenerationConfig, snowSql: SnowSqlFn, jobId: string): Promise<void> {
  if (pois.length === 0) return;
  const batchSize = 500;
  for (let i = 0; i < pois.length; i += batchSize) {
    const chunk = pois.slice(i, i + batchSize);
    const selects = chunk.map((p: any) =>
      `SELECT ${escVal(p.location_id)},${escVal(config.region)},${escVal(p.name)},${escVal(p.location_type)},` +
      `${escVal(p.category)},${p.lat},${p.lng},ST_MAKEPOINT(${p.lng},${p.lat}),${escVal(p.source || 'generated')},` +
      `${escVal(jobId)}`
    ).join(' UNION ALL\n');
    const sql = `INSERT INTO ${UNIFIED_DB}.${UNIFIED_SCHEMA}.DIM_POIS
      (LOCATION_ID,REGION,NAME,LOCATION_TYPE,CATEGORY,LAT,LNG,POINT_GEOM,SOURCE,JOB_ID)
      ${selects}`;
    try {
      await snowSql(sql, UNIFIED_DB, UNIFIED_SCHEMA);
    } catch (e: any) {
      const msg = `DIM_POIS insert error (batch ${i}-${i + batchSize}): ${e.message?.slice(0, 200)}`;
      log('ERROR', 'Studio', msg);
      throw new Error(msg);
    }
  }
}

export async function insertFactFreightOffers(offers: any[], config: GenerationConfig, snowSql: SnowSqlFn, jobId: string): Promise<number> {
  if (offers.length === 0) return 0;
  const vt = resolveVehicleType(config);
  const batchSize = 500;
  let inserted = 0;
  for (let i = 0; i < offers.length; i += batchSize) {
    const chunk = offers.slice(i, i + batchSize);
    const selects = chunk.map((o: any) =>
      `SELECT ${escVal(o.offer_id)},${escVal(config.region)},${escVal(vt)},${escVal(o.source)},` +
      `${escVal(o.pickup_poi_id)},${o.pickup_lat},${o.pickup_lon},ST_MAKEPOINT(${o.pickup_lon},${o.pickup_lat}),` +
      `${escVal(o.dropoff_poi_id)},${o.dropoff_lat},${o.dropoff_lon},ST_MAKEPOINT(${o.dropoff_lon},${o.dropoff_lat}),` +
      `DATEADD(MINUTE, ${o.pickup_from_offset_min}, CURRENT_TIMESTAMP()),` +
      `DATEADD(MINUTE, ${o.pickup_to_offset_min}, CURRENT_TIMESTAMP()),` +
      `${o.weight_kg},${escVal(o.product)},${o.price_usd},${o.hazmat ? 'TRUE' : 'FALSE'},` +
      `${escVal(o.listing_text)},CURRENT_TIMESTAMP(),${escVal(jobId)}`
    ).join(' UNION ALL\n');
    const sql = `INSERT INTO ${UNIFIED_DB}.${UNIFIED_SCHEMA}.FACT_FREIGHT_OFFERS
      (OFFER_ID,REGION,VEHICLE_TYPE,SOURCE,
       PICKUP_POI_ID,PICKUP_LAT,PICKUP_LON,PICKUP_GEOM,
       DROPOFF_POI_ID,DROPOFF_LAT,DROPOFF_LON,DROPOFF_GEOM,
       PICKUP_FROM_TS,PICKUP_TO_TS,WEIGHT_KG,PRODUCT,PRICE_USD,HAZMAT,
       LISTING_TEXT,POSTED_AT,JOB_ID)
      ${selects}`;
    try {
      await snowSql(sql, UNIFIED_DB, UNIFIED_SCHEMA);
      inserted += chunk.length;
    } catch (e: any) {
      const msg = `FACT_FREIGHT_OFFERS insert error (batch ${i}-${i + batchSize}): ${e.message?.slice(0, 200)}`;
      log('ERROR', 'Studio', msg);
      throw new Error(msg);
    }
  }
  return inserted;
}

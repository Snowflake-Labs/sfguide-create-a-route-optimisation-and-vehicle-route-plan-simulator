import os
import snowflake.connector
import time

conn = snowflake.connector.connect(
    connection_name=os.getenv("SNOWFLAKE_CONNECTION_NAME") or "fleet_test_evals"
)
cursor = conn.cursor()

cursor.execute("""
    SELECT DISTINCT s.ORIGIN_ID, s.DEST_ID, o.LNG AS O_LNG, o.LAT AS O_LAT, d.LNG AS D_LNG, d.LAT AS D_LAT
    FROM SYNTHETIC_DATASETS.FLEET_INTELLIGENCE.TRIP_SCHEDULE s
    JOIN SYNTHETIC_DATASETS.FLEET_INTELLIGENCE.GERMANY_DESTINATIONS o ON s.ORIGIN_ID = o.ID
    JOIN SYNTHETIC_DATASETS.FLEET_INTELLIGENCE.GERMANY_DESTINATIONS d ON s.DEST_ID = d.ID
    LEFT JOIN FLEET_INTELLIGENCE.ROUTE_CACHE.ROUTE_CACHE rc
        ON s.ORIGIN_ID = rc.ORIGIN_ID AND s.DEST_ID = rc.DEST_ID
    WHERE rc.ORIGIN_ID IS NULL
""")
pairs = cursor.fetchall()
print(f"Total OD pairs to route: {len(pairs)}")

BATCH_SIZE = 200
success_count = 0
fail_count = 0
start_time = time.time()

for i in range(0, len(pairs), BATCH_SIZE):
    batch = pairs[i:i+BATCH_SIZE]
    values = []
    for origin_id, dest_id, o_lng, o_lat, d_lng, d_lat in batch:
        oid = str(origin_id).replace("'", "''")
        did = str(dest_id).replace("'", "''")
        values.append(f"""
            SELECT
                '{oid}' AS ORIGIN_ID,
                '{did}' AS DEST_ID,
                {o_lng} AS O_LNG, {o_lat} AS O_LAT,
                {d_lng} AS D_LNG, {d_lat} AS D_LAT
        """)
    union_sql = " UNION ALL ".join(values)

    insert_sql = f"""
        INSERT INTO FLEET_INTELLIGENCE.ROUTE_CACHE.ROUTE_CACHE
            (ORIGIN_ID, DEST_ID, ROAD_DISTANCE_M, DURATION_SECONDS, ROUTE_LINE)
        SELECT
            pairs.ORIGIN_ID, pairs.DEST_ID,
            ors.DISTANCE, ors.DURATION, ors.GEOJSON
        FROM ({union_sql}) pairs,
        TABLE(OPENROUTESERVICE_NATIVE_APP.CORE.DIRECTIONS_GEO(
            'driving-car',
            OBJECT_CONSTRUCT('coordinates', ARRAY_CONSTRUCT(
                ARRAY_CONSTRUCT(pairs.O_LNG, pairs.O_LAT),
                ARRAY_CONSTRUCT(pairs.D_LNG, pairs.D_LAT)
            ))::VARIANT
        )) ors
    """
    try:
        cursor.execute(insert_sql)
        batch_rows = cursor.rowcount
        success_count += batch_rows
    except Exception as e:
        fail_count += len(batch)
        print(f"Batch {i//BATCH_SIZE + 1} FAILED: {str(e)[:100]}")
    
    done = min(i + BATCH_SIZE, len(pairs))
    elapsed = time.time() - start_time
    print(f"Batch {i//BATCH_SIZE + 1}/{(len(pairs)-1)//BATCH_SIZE + 1}: {done}/{len(pairs)} pairs | inserted: {success_count} | elapsed: {elapsed:.0f}s")

cursor.execute("SELECT COUNT(*) FROM FLEET_INTELLIGENCE.ROUTE_CACHE.ROUTE_CACHE")
total = cursor.fetchone()[0]
print(f"\nRoute cache total: {total}")
print(f"Success: {success_count}, Failed batches: {fail_count}")
conn.close()

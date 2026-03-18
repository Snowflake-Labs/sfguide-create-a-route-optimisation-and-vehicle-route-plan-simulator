"""
Snowflake I/O Module - DDL generation, Parquet staging, and COPY INTO loading.

Implements:
- Table DDL with appropriate Snowflake types
- Internal stage management
- Parquet file writing with pyarrow
- Efficient COPY INTO for bulk loading
- Clustering recommendations
"""

import os
import logging
from pathlib import Path
from typing import Dict, List, Optional, Any
import pandas as pd

logger = logging.getLogger(__name__)


# =============================================================================
# DDL DEFINITIONS
# =============================================================================

DDL_STATEMENTS = {
    'DIM_WAREHOUSE': """
CREATE TABLE IF NOT EXISTS {schema}.DIM_WAREHOUSE (
    WAREHOUSE_ID VARCHAR(100) PRIMARY KEY,
    NAME VARCHAR(500),
    CATEGORY VARCHAR(100),
    LOCATION_TYPE VARCHAR(50),
    LONGITUDE FLOAT,
    LATITUDE FLOAT,
    GEOG GEOGRAPHY,
    CITY VARCHAR(200),
    ADDRESS VARCHAR(500),
    CREATED_AT TIMESTAMP_NTZ DEFAULT CURRENT_TIMESTAMP()
)
""",

    'DIM_STOP': """
CREATE TABLE IF NOT EXISTS {schema}.DIM_STOP (
    REST_STOP_ID VARCHAR(100) PRIMARY KEY,
    NAME VARCHAR(500),
    REST_TYPE VARCHAR(50),
    LONGITUDE FLOAT,
    LATITUDE FLOAT,
    GEOG GEOGRAPHY,
    HAS_EV_CHARGING BOOLEAN,
    AREA_M2 FLOAT,
    CAPACITY_RATING VARCHAR(50),
    CREATED_AT TIMESTAMP_NTZ DEFAULT CURRENT_TIMESTAMP()
)
""",

    'DIM_TRUCK': """
CREATE TABLE IF NOT EXISTS {schema}.DIM_TRUCK (
    TRUCK_ID VARCHAR(50) PRIMARY KEY,
    DRIVER_ID VARCHAR(50),
    HOME_BASE_ID VARCHAR(100),
    HOME_LNG FLOAT,
    HOME_LAT FLOAT,
    TRUCK_TYPE VARCHAR(50),
    DRIVER_PROFILE VARCHAR(50),
    BASE_SPEED_KMH FLOAT,
    SHIFT_TYPE VARCHAR(50),
    CREATED_AT TIMESTAMP_NTZ DEFAULT CURRENT_TIMESTAMP()
)
""",

    'DIM_DRIVER': """
CREATE TABLE IF NOT EXISTS {schema}.DIM_DRIVER (
    DRIVER_ID VARCHAR(50) PRIMARY KEY,
    TRUCK_ID VARCHAR(50),
    PROFILE_TYPE VARCHAR(50),
    DETOUR_PROBABILITY FLOAT,
    SPEEDING_PROBABILITY FLOAT,
    HOS_VIOLATION_PROBABILITY FLOAT,
    SPEED_VARIANCE FLOAT,
    CREATED_AT TIMESTAMP_NTZ DEFAULT CURRENT_TIMESTAMP()
)
""",

    'FACT_TRIP': """
CREATE TABLE IF NOT EXISTS {schema}.FACT_TRIP (
    TRIP_ID VARCHAR(100) PRIMARY KEY,
    TRUCK_ID VARCHAR(50),
    DRIVER_ID VARCHAR(50),
    ORIGIN_ID VARCHAR(100),
    DEST_ID VARCHAR(100),
    ORIGIN_LNG FLOAT,
    ORIGIN_LAT FLOAT,
    DEST_LNG FLOAT,
    DEST_LAT FLOAT,
    SCHEDULED_START TIMESTAMP_NTZ,
    TRIP_TYPE VARCHAR(50),
    ROUTE_VARIATION VARCHAR(50),
    DISTANCE_KM FLOAT,
    DURATION_MIN FLOAT,
    IS_DETOUR BOOLEAN,
    ROUTE_GEOG GEOGRAPHY,
    CREATED_AT TIMESTAMP_NTZ DEFAULT CURRENT_TIMESTAMP()
)
""",

    'FACT_TRUCK_TELEMETRY': """
CREATE TABLE IF NOT EXISTS {schema}.FACT_TRUCK_TELEMETRY (
    TELEMETRY_ID VARCHAR(36) PRIMARY KEY,
    TRUCK_ID VARCHAR(50),
    DRIVER_ID VARCHAR(50),
    TRIP_ID VARCHAR(100),
    TS TIMESTAMP_NTZ,
    LATITUDE FLOAT,
    LONGITUDE FLOAT,
    GEOG GEOGRAPHY,
    SPEED_KMH FLOAT,
    HEADING_DEG FLOAT,
    POSTED_SPEED_KMH FLOAT,
    STATUS VARCHAR(50),
    IS_SPEEDING BOOLEAN,
    IS_HOS_VIOLATION BOOLEAN,
    IS_DETOUR BOOLEAN,
    GPS_ACCURACY_M FLOAT,
    LOCATION_ID VARCHAR(100),
    LOCATION_TYPE VARCHAR(50),
    CREATED_AT TIMESTAMP_NTZ DEFAULT CURRENT_TIMESTAMP()
)
""",

    'FACT_VIOLATION': """
CREATE TABLE IF NOT EXISTS {schema}.FACT_VIOLATION (
    VIOLATION_ID VARCHAR(36) PRIMARY KEY,
    TRUCK_ID VARCHAR(50),
    TRIP_ID VARCHAR(100),
    VIOLATION_TYPE VARCHAR(50),
    START_TIME TIMESTAMP_NTZ,
    END_TIME TIMESTAMP_NTZ,
    DURATION_MINUTES FLOAT,
    MAX_SPEED_KMH FLOAT,
    POSTED_SPEED_KMH FLOAT,
    CREATED_AT TIMESTAMP_NTZ DEFAULT CURRENT_TIMESTAMP()
)
"""
}

CLUSTERING_STATEMENTS = {
    'FACT_TRUCK_TELEMETRY': """
ALTER TABLE {schema}.FACT_TRUCK_TELEMETRY 
CLUSTER BY (TO_DATE(TS), TRUCK_ID)
""",
    'FACT_TRIP': """
ALTER TABLE {schema}.FACT_TRIP 
CLUSTER BY (TO_DATE(SCHEDULED_START), TRUCK_ID)
""",
    'FACT_VIOLATION': """
ALTER TABLE {schema}.FACT_VIOLATION 
CLUSTER BY (TO_DATE(START_TIME), VIOLATION_TYPE)
"""
}


def get_snowflake_connection(connection_name: Optional[str] = None):
    """Get Snowflake connection."""
    import snowflake.connector
    conn_name = connection_name or os.getenv("SNOWFLAKE_CONNECTION_NAME") or "default"
    return snowflake.connector.connect(connection_name=conn_name)


def create_schema(conn, database: str, schema: str):
    """Create schema if not exists."""
    cursor = conn.cursor()
    try:
        cursor.execute(f"CREATE SCHEMA IF NOT EXISTS {database}.{schema}")
        logger.info(f"Schema {database}.{schema} ready")
    finally:
        cursor.close()


def create_tables(conn, schema: str, tables: Optional[List[str]] = None):
    """
    Create tables with DDL.
    
    Args:
        conn: Snowflake connection
        schema: Database.schema prefix
        tables: Optional list of table names to create. If None, creates all.
    """
    cursor = conn.cursor()
    
    tables_to_create = tables or list(DDL_STATEMENTS.keys())
    
    for table_name in tables_to_create:
        if table_name not in DDL_STATEMENTS:
            logger.warning(f"Unknown table: {table_name}")
            continue
        
        ddl = DDL_STATEMENTS[table_name].format(schema=schema)
        try:
            cursor.execute(ddl)
            logger.info(f"Created table {schema}.{table_name}")
        except Exception as e:
            logger.error(f"Failed to create {table_name}: {e}")
    
    cursor.close()


def apply_clustering(conn, schema: str, tables: Optional[List[str]] = None):
    """Apply clustering keys to tables."""
    cursor = conn.cursor()
    
    tables_to_cluster = tables or list(CLUSTERING_STATEMENTS.keys())
    
    for table_name in tables_to_cluster:
        if table_name not in CLUSTERING_STATEMENTS:
            continue
        
        stmt = CLUSTERING_STATEMENTS[table_name].format(schema=schema)
        try:
            cursor.execute(stmt)
            logger.info(f"Applied clustering to {schema}.{table_name}")
        except Exception as e:
            logger.warning(f"Failed to cluster {table_name}: {e}")
    
    cursor.close()


def create_stage(conn, schema: str, stage_name: str = "TELEMETRY_STAGE"):
    """Create internal stage for Parquet files."""
    cursor = conn.cursor()
    try:
        cursor.execute(f"""
            CREATE STAGE IF NOT EXISTS {schema}.{stage_name}
            FILE_FORMAT = (TYPE = PARQUET)
        """)
        logger.info(f"Created stage {schema}.{stage_name}")
    finally:
        cursor.close()


# =============================================================================
# PARQUET WRITING
# =============================================================================

def write_parquet(
    df: pd.DataFrame,
    output_dir: str,
    filename: str,
    compression: str = 'snappy'
) -> str:
    """
    Write DataFrame to Parquet file.
    
    Args:
        df: DataFrame to write
        output_dir: Output directory
        filename: Filename without extension
        compression: Compression algorithm
        
    Returns:
        Path to written file
    """
    import pyarrow as pa
    import pyarrow.parquet as pq
    
    output_path = Path(output_dir)
    output_path.mkdir(parents=True, exist_ok=True)
    
    filepath = output_path / f"{filename}.parquet"
    
    # Convert to Arrow table
    table = pa.Table.from_pandas(df)
    
    # Write Parquet
    pq.write_table(table, filepath, compression=compression)
    
    logger.info(f"Wrote {len(df)} rows to {filepath}")
    return str(filepath)


def write_telemetry_parquet(
    df: pd.DataFrame,
    output_dir: str,
    chunk_id: str
) -> str:
    """Write telemetry DataFrame to Parquet with proper column mapping."""
    # Rename columns to match DDL
    column_mapping = {
        'timestamp': 'TS',
        'heading_deg': 'HEADING_DEG',
        'is_hos_violation': 'IS_HOS_VIOLATION'
    }
    
    df_out = df.rename(columns={k: v for k, v in column_mapping.items() if k in df.columns})
    df_out.columns = [c.upper() for c in df_out.columns]
    
    return write_parquet(df_out, output_dir, f"telemetry_{chunk_id}")


# =============================================================================
# COPY INTO LOADING
# =============================================================================

def upload_to_stage(
    conn,
    local_path: str,
    stage_path: str
):
    """Upload local file to Snowflake stage."""
    cursor = conn.cursor()
    try:
        cursor.execute(f"PUT 'file://{local_path}' {stage_path} AUTO_COMPRESS=FALSE OVERWRITE=TRUE")
        logger.info(f"Uploaded {local_path} to {stage_path}")
    finally:
        cursor.close()


def copy_into_table(
    conn,
    schema: str,
    table_name: str,
    stage_path: str,
    file_pattern: str = ".*\\.parquet"
) -> int:
    """
    Load data from stage into table using COPY INTO.
    
    Returns number of rows loaded.
    """
    cursor = conn.cursor()
    try:
        # Get column list from table
        cursor.execute(f"DESC TABLE {schema}.{table_name}")
        columns = [row[0] for row in cursor.fetchall()]
        column_list = ", ".join(columns)
        
        # Build COPY INTO with column mapping
        copy_stmt = f"""
        COPY INTO {schema}.{table_name} ({column_list})
        FROM {stage_path}
        FILE_FORMAT = (TYPE = PARQUET)
        PATTERN = '{file_pattern}'
        MATCH_BY_COLUMN_NAME = CASE_INSENSITIVE
        ON_ERROR = CONTINUE
        """
        
        cursor.execute(copy_stmt)
        result = cursor.fetchone()
        rows_loaded = result[0] if result else 0
        
        logger.info(f"Loaded {rows_loaded} rows into {schema}.{table_name}")
        return rows_loaded
        
    except Exception as e:
        logger.error(f"COPY INTO failed: {e}")
        raise
    finally:
        cursor.close()


def load_telemetry_from_parquet(
    conn,
    schema: str,
    parquet_dir: str,
    stage_name: str = "TELEMETRY_STAGE"
) -> int:
    """
    Load all telemetry Parquet files to Snowflake.
    
    1. Upload Parquet files to stage
    2. COPY INTO table
    3. Return total rows loaded
    """
    stage_path = f"@{schema}.{stage_name}"
    parquet_path = Path(parquet_dir)
    
    total_rows = 0
    
    for parquet_file in parquet_path.glob("telemetry_*.parquet"):
        # Upload to stage
        upload_to_stage(conn, str(parquet_file), stage_path)
    
    # COPY INTO
    total_rows = copy_into_table(
        conn, schema, "FACT_TRUCK_TELEMETRY",
        stage_path, "telemetry_.*\\.parquet"
    )
    
    return total_rows


def load_dimension_table(
    conn,
    schema: str,
    table_name: str,
    df: pd.DataFrame,
    truncate_first: bool = True
):
    """
    Load a dimension table directly via INSERT.
    
    For small dimension tables, direct INSERT is simpler than Parquet staging.
    """
    from snowflake.connector.pandas_tools import write_pandas
    
    cursor = conn.cursor()
    
    try:
        if truncate_first:
            cursor.execute(f"TRUNCATE TABLE IF EXISTS {schema}.{table_name}")
        
        # Uppercase column names
        df_out = df.copy()
        df_out.columns = [c.upper() for c in df_out.columns]
        
        # Write using pandas connector
        success, nchunks, nrows, _ = write_pandas(
            conn, df_out, table_name.upper(),
            database=schema.split('.')[0],
            schema=schema.split('.')[1],
            auto_create_table=False
        )
        
        if 'TS' in df_out.columns:
            cursor.execute(f"""
                UPDATE {schema}.{table_name}
                SET TS = TO_TIMESTAMP(DATE_PART('epoch_second', TS) / 1000000)
                WHERE DATE_PART('epoch_second', TS) > 1e12
            """)
            logger.info(f"Applied TS epoch fix to {schema}.{table_name}")
        
        logger.info(f"Loaded {nrows} rows into {schema}.{table_name}")
        return nrows
        
    except Exception as e:
        logger.error(f"Failed to load {table_name}: {e}")
        raise
    finally:
        cursor.close()


# =============================================================================
# CLEANUP
# =============================================================================

def coords_to_wkt_linestring(coords: List[tuple]) -> str:
    """Convert list of (lng, lat) tuples to WKT LINESTRING."""
    if not coords or len(coords) < 2:
        return None
    points = ", ".join([f"{lng} {lat}" for lng, lat in coords])
    return f"LINESTRING({points})"


def load_trips_table(
    conn,
    schema: str,
    trips: List,
    truncate_first: bool = True
) -> int:
    """
    Load trip metadata with route geometry into FACT_TRIP.
    
    Args:
        conn: Snowflake connection
        schema: Database.schema
        trips: List of Trip objects with route data
        truncate_first: Whether to truncate table first
        
    Returns:
        Number of rows loaded
    """
    cursor = conn.cursor()
    
    try:
        if truncate_first:
            cursor.execute(f"TRUNCATE TABLE IF EXISTS {schema}.FACT_TRIP")
        
        insert_count = 0
        batch_size = 100
        
        for i in range(0, len(trips), batch_size):
            batch = trips[i:i + batch_size]
            values = []
            
            for trip in batch:
                route = trip.route
                route_wkt = None
                distance_km = None
                duration_min = None
                
                if route:
                    route_wkt = coords_to_wkt_linestring(route.coordinates)
                    distance_km = route.distance_km
                    duration_min = route.duration_min
                
                geog_expr = f"ST_GEOGRAPHYFROMWKT('{route_wkt}')" if route_wkt else "NULL"
                
                values.append(f"""(
                    '{trip.trip_id}',
                    '{trip.truck_id}',
                    '{trip.driver_id}',
                    '{trip.origin_id}',
                    '{trip.dest_id}',
                    {trip.origin_coords[0]},
                    {trip.origin_coords[1]},
                    {trip.dest_coords[0]},
                    {trip.dest_coords[1]},
                    '{trip.scheduled_start.isoformat()}',
                    '{trip.trip_type}',
                    '{trip.route_variation}',
                    {distance_km or 'NULL'},
                    {duration_min or 'NULL'},
                    {str(trip.is_detour).upper()},
                    {geog_expr}
                )""")
            
            insert_sql = f"""
            INSERT INTO {schema}.FACT_TRIP 
            (TRIP_ID, TRUCK_ID, DRIVER_ID, ORIGIN_ID, DEST_ID,
             ORIGIN_LNG, ORIGIN_LAT, DEST_LNG, DEST_LAT,
             SCHEDULED_START, TRIP_TYPE, ROUTE_VARIATION,
             DISTANCE_KM, DURATION_MIN, IS_DETOUR, ROUTE_GEOG)
            VALUES {', '.join(values)}
            """
            
            cursor.execute(insert_sql)
            insert_count += len(batch)
        
        logger.info(f"Loaded {insert_count} trips into {schema}.FACT_TRIP")
        return insert_count
        
    except Exception as e:
        logger.error(f"Failed to load trips: {e}")
        raise
    finally:
        cursor.close()


def load_violations_table(
    conn,
    schema: str,
    violations_df: pd.DataFrame,
    truncate_first: bool = True
) -> int:
    """
    Load violation records into FACT_VIOLATION.
    
    Args:
        conn: Snowflake connection
        schema: Database.schema
        violations_df: DataFrame with violation records
        truncate_first: Whether to truncate table first
        
    Returns:
        Number of rows loaded
    """
    if violations_df.empty:
        logger.info("No violations to load")
        return 0
    
    from snowflake.connector.pandas_tools import write_pandas
    
    cursor = conn.cursor()
    
    try:
        if truncate_first:
            cursor.execute(f"TRUNCATE TABLE IF EXISTS {schema}.FACT_VIOLATION")
        
        df_out = violations_df.copy()
        df_out.columns = [c.upper() for c in df_out.columns]
        
        success, nchunks, nrows, _ = write_pandas(
            conn, df_out, "FACT_VIOLATION",
            database=schema.split('.')[0],
            schema=schema.split('.')[1],
            auto_create_table=False
        )
        
        for ts_col in ['START_TIME', 'END_TIME']:
            if ts_col in df_out.columns:
                cursor.execute(f"""
                    UPDATE {schema}.FACT_VIOLATION
                    SET {ts_col} = TO_TIMESTAMP(DATE_PART('epoch_second', {ts_col}) / 1000000)
                    WHERE DATE_PART('epoch_second', {ts_col}) > 1e12
                """)
        logger.info(f"Applied timestamp epoch fix to {schema}.FACT_VIOLATION")
        
        logger.info(f"Loaded {nrows} violations into {schema}.FACT_VIOLATION")
        return nrows
        
    except Exception as e:
        logger.error(f"Failed to load violations: {e}")
        raise
    finally:
        cursor.close()


def cleanup_stage(conn, stage_path: str, pattern: str = ".*"):
    """Remove files from stage."""
    cursor = conn.cursor()
    try:
        cursor.execute(f"REMOVE {stage_path} PATTERN='{pattern}'")
        logger.info(f"Cleaned up {stage_path}")
    finally:
        cursor.close()


def cleanup_local_parquet(parquet_dir: str):
    """Remove local Parquet files."""
    parquet_path = Path(parquet_dir)
    for f in parquet_path.glob("*.parquet"):
        f.unlink()
    logger.info(f"Cleaned up local Parquet files in {parquet_dir}")


# =============================================================================
# CONVENIENCE FUNCTIONS
# =============================================================================

def setup_schema_and_tables(config: dict) -> None:
    """Set up schema and all tables."""
    sf_config = config['snowflake']
    schema = f"{sf_config['database']}.{sf_config['schema']}"
    
    conn = get_snowflake_connection(sf_config.get('connection_name'))
    
    try:
        create_schema(conn, sf_config['database'], sf_config['schema'])
        create_tables(conn, schema)
        create_stage(conn, schema)
        apply_clustering(conn, schema)
    finally:
        conn.close()


def get_table_row_count(conn, schema: str, table_name: str) -> int:
    """Get row count for a table."""
    cursor = conn.cursor()
    try:
        cursor.execute(f"SELECT COUNT(*) FROM {schema}.{table_name}")
        return cursor.fetchone()[0]
    except:
        return 0
    finally:
        cursor.close()

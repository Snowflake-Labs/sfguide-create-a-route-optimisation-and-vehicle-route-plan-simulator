#!/usr/bin/env python3
"""
Synthetic Truck Telemetry Generator - CLI

Generates realistic GPS telemetry data for HGV trucks operating in Germany.
Uses Overture Maps for POIs, ORS for road-following routes, and realistic
driver behavior profiles.

Usage:
    python main.py generate --config config/config.yml
    python main.py qa --config config/config.yml
    python main.py setup --config config/config.yml
"""

import argparse
import logging
import sys
from datetime import datetime, timedelta
from pathlib import Path

import yaml

logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(name)s - %(levelname)s - %(message)s'
)
logger = logging.getLogger(__name__)


def load_config(config_path: str) -> dict:
    """Load configuration from YAML file."""
    with open(config_path, 'r') as f:
        return yaml.safe_load(f)


def cmd_setup(args):
    """Set up Snowflake schema and tables."""
    from src.snowflake_io import setup_schema_and_tables
    
    config = load_config(args.config)
    logger.info("Setting up Snowflake schema and tables...")
    setup_schema_and_tables(config)
    logger.info("Setup complete!")


def cmd_generate(args):
    """Generate synthetic telemetry data."""
    import numpy as np
    import pandas as pd
    from dateutil.relativedelta import relativedelta
    
    from src.overture import load_all_poi_data, get_snowflake_connection
    from src.routing import ORSRouter
    from src.driver_profiles import assign_driver_profiles, BehaviorSimulator
    from src.simulate import TruckAssignment, generate_telemetry_chunked
    from src.snowflake_io import (
        write_telemetry_parquet, load_telemetry_from_parquet,
        load_dimension_table, create_stage, load_trips_table, load_violations_table
    )
    
    config = load_config(args.config)
    seed = config.get('seed', 42)
    rng = np.random.default_rng(seed)
    
    sf_config = config['snowflake']
    schema = f"{sf_config['database']}.{sf_config['schema']}"
    output_dir = config['output']['parquet_dir']
    
    logger.info(f"Starting telemetry generation with seed={seed}")
    
    # Load POI data
    logger.info("Loading POI data from Snowflake...")
    poi_data = load_all_poi_data(config)
    logger.info(f"Loaded {len(poi_data.warehouses)} warehouses, "
                f"{len(poi_data.destinations)} destinations, "
                f"{len(poi_data.rest_stops)} rest stops")
    
    # Assign driver profiles
    num_trucks = config['fleet']['num_trucks']
    logger.info(f"Assigning profiles to {num_trucks} trucks...")
    driver_assignments = assign_driver_profiles(num_trucks, config, seed)
    
    # Create truck assignments
    trucks = []
    for i, (driver_id, profile) in enumerate(driver_assignments):
        home = poi_data.warehouses.sample(n=1, random_state=int(rng.integers(1e9))).iloc[0]
        home_id = home.get('warehouse_id') or home.get('destination_id')
        
        trucks.append(TruckAssignment(
            truck_id=f"TRK-{i:05d}",
            driver_id=driver_id,
            profile=profile,
            home_base_id=home_id,
            home_coords=(home['longitude'], home['latitude']),
            truck_type=rng.choice(['18_WHEELER', 'BOX_TRUCK', 'TANKER']),
            base_speed_kmh=rng.uniform(70, 85)
        ))
    
    # Initialize router
    conn = get_snowflake_connection(sf_config.get('connection_name'))
    router = ORSRouter(config, conn)
    
    # Calculate date range
    time_config = config['time']
    start_date = datetime.strptime(time_config['start_date'], "%Y-%m-%d").date()
    end_date = start_date + relativedelta(months=time_config['duration_months']) - timedelta(days=1)
    chunk_days = time_config['chunk_size_days']
    
    logger.info(f"Generating telemetry from {start_date} to {end_date}")
    
    # Generate in chunks
    Path(output_dir).mkdir(parents=True, exist_ok=True)
    total_points = 0
    total_trips = 0
    total_violations = 0
    chunk_id = 0
    
    all_trips = []
    all_violations = []
    
    for result in generate_telemetry_chunked(
        config=config,
        trucks=trucks,
        router=router,
        warehouses=poi_data.warehouses,
        destinations=poi_data.destinations,
        rest_stops=poi_data.rest_stops,
        start_date=start_date,
        end_date=end_date,
        chunk_size_days=chunk_days
    ):
        # Write telemetry to Parquet
        parquet_file = write_telemetry_parquet(result.telemetry_df, output_dir, f"{chunk_id:04d}")
        total_points += len(result.telemetry_df)
        total_trips += len(result.trips)
        total_violations += len(result.violations_df)
        
        logger.info(f"Chunk {chunk_id}: {len(result.telemetry_df):,} points, "
                    f"{len(result.trips)} trips, {len(result.violations_df)} violations")
        
        # Accumulate trips and violations for loading
        all_trips.extend(result.trips)
        if not result.violations_df.empty:
            all_violations.append(result.violations_df)
        
        chunk_id += 1
    
    logger.info(f"Generated {total_points:,} telemetry points, "
                f"{total_trips:,} trips, {total_violations:,} violations")
    
    # Load to Snowflake if requested
    if args.load:
        logger.info("Loading data to Snowflake...")
        create_stage(conn, schema)
        
        # Load telemetry
        rows_loaded = load_telemetry_from_parquet(conn, schema, output_dir)
        logger.info(f"Loaded {rows_loaded:,} telemetry rows")
        
        # Load trips with route geometry
        if all_trips:
            load_trips_table(conn, schema, all_trips)
        
        # Load violations
        if all_violations:
            violations_df = pd.concat(all_violations, ignore_index=True)
            load_violations_table(conn, schema, violations_df)
        
        # Load dimension tables
        trucks_df = pd.DataFrame([{
            'truck_id': t.truck_id,
            'driver_id': t.driver_id,
            'home_base_id': t.home_base_id,
            'home_lng': t.home_coords[0],
            'home_lat': t.home_coords[1],
            'truck_type': t.truck_type,
            'driver_profile': t.profile.profile_type.value,
            'base_speed_kmh': t.base_speed_kmh,
            'shift_type': 'DAY'
        } for t in trucks])
        load_dimension_table(conn, schema, 'DIM_TRUCK', trucks_df)
        
        load_dimension_table(conn, schema, 'DIM_WAREHOUSE', poi_data.warehouses)
        load_dimension_table(conn, schema, 'DIM_STOP', poi_data.rest_stops)
    
    conn.close()
    logger.info("Generation complete!")


def cmd_qa(args):
    """Run QA validation suite."""
    from src.qa import run_full_qa, qa_results_to_dataframe
    
    config = load_config(args.config)
    logger.info("Running QA validation suite...")
    
    results = run_full_qa(config)
    
    # Save results
    if args.output:
        df = qa_results_to_dataframe(results)
        df.to_csv(args.output, index=False)
        logger.info(f"QA results saved to {args.output}")
    
    # Return exit code based on results
    failed = sum(1 for r in results if not r.passed)
    if failed > 0:
        logger.warning(f"{failed} QA checks failed!")
        return 1
    
    logger.info("All QA checks passed!")
    return 0


def main():
    parser = argparse.ArgumentParser(
        description="Synthetic Truck Telemetry Generator",
        formatter_class=argparse.RawDescriptionHelpFormatter
    )
    
    subparsers = parser.add_subparsers(dest='command', help='Commands')
    
    # Setup command
    setup_parser = subparsers.add_parser('setup', help='Set up Snowflake schema and tables')
    setup_parser.add_argument('--config', default='config/config.yml', help='Config file path')
    
    # Generate command
    gen_parser = subparsers.add_parser('generate', help='Generate synthetic telemetry')
    gen_parser.add_argument('--config', default='config/config.yml', help='Config file path')
    gen_parser.add_argument('--load', action='store_true', help='Load to Snowflake after generation')
    gen_parser.add_argument('--seed', type=int, help='Override random seed')
    
    # QA command
    qa_parser = subparsers.add_parser('qa', help='Run QA validation')
    qa_parser.add_argument('--config', default='config/config.yml', help='Config file path')
    qa_parser.add_argument('--output', help='Output CSV file for QA results')
    
    args = parser.parse_args()
    
    if args.command == 'setup':
        cmd_setup(args)
    elif args.command == 'generate':
        cmd_generate(args)
    elif args.command == 'qa':
        sys.exit(cmd_qa(args))
    else:
        parser.print_help()
        sys.exit(1)


if __name__ == '__main__':
    main()

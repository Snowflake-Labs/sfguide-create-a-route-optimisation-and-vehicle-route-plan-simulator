"""
QA Module - Validation queries for data quality checks.

Implements:
- Row count validation
- Temporal coverage checks
- Spatial bounds validation
- Distribution checks (speeding %, detour %, HOS violations)
- Route geometry quality checks
"""

import logging
from dataclasses import dataclass
from typing import Dict, List, Optional, Tuple
import pandas as pd

logger = logging.getLogger(__name__)


@dataclass
class QAResult:
    """Container for QA check result."""
    check_name: str
    passed: bool
    expected: str
    actual: str
    details: Optional[str] = None


def get_snowflake_connection(connection_name=None):
    """Get Snowflake connection."""
    import os
    import snowflake.connector
    conn_name = connection_name or os.getenv("SNOWFLAKE_CONNECTION_NAME") or "default"
    return snowflake.connector.connect(connection_name=conn_name)


# =============================================================================
# ROW COUNT CHECKS
# =============================================================================

def check_row_counts(
    conn,
    schema: str,
    expected_counts: Dict[str, Tuple[int, int]]  # table -> (min, max)
) -> List[QAResult]:
    """
    Validate row counts are within expected ranges.
    """
    results = []
    cursor = conn.cursor()
    
    for table, (min_count, max_count) in expected_counts.items():
        try:
            cursor.execute(f"SELECT COUNT(*) FROM {schema}.{table}")
            actual = cursor.fetchone()[0]
            
            passed = min_count <= actual <= max_count
            results.append(QAResult(
                check_name=f"row_count_{table}",
                passed=passed,
                expected=f"{min_count:,} - {max_count:,}",
                actual=f"{actual:,}",
                details=f"Row count for {table}"
            ))
        except Exception as e:
            results.append(QAResult(
                check_name=f"row_count_{table}",
                passed=False,
                expected=f"{min_count:,} - {max_count:,}",
                actual="ERROR",
                details=str(e)
            ))
    
    cursor.close()
    return results


# =============================================================================
# TEMPORAL COVERAGE
# =============================================================================

def check_temporal_coverage(
    conn,
    schema: str,
    table: str,
    timestamp_col: str,
    expected_start: str,
    expected_end: str
) -> List[QAResult]:
    """Check date range coverage."""
    results = []
    cursor = conn.cursor()
    
    try:
        cursor.execute(f"""
            SELECT 
                MIN({timestamp_col})::DATE as min_date,
                MAX({timestamp_col})::DATE as max_date,
                COUNT(DISTINCT {timestamp_col}::DATE) as num_days
            FROM {schema}.{table}
        """)
        row = cursor.fetchone()
        min_date, max_date, num_days = row
        
        # Check start date
        results.append(QAResult(
            check_name=f"temporal_start_{table}",
            passed=str(min_date) <= expected_start,
            expected=f"<= {expected_start}",
            actual=str(min_date)
        ))
        
        # Check end date
        results.append(QAResult(
            check_name=f"temporal_end_{table}",
            passed=str(max_date) >= expected_end,
            expected=f">= {expected_end}",
            actual=str(max_date)
        ))
        
        # Check continuity
        expected_days = (pd.to_datetime(expected_end) - pd.to_datetime(expected_start)).days + 1
        coverage = num_days / expected_days if expected_days > 0 else 0
        
        results.append(QAResult(
            check_name=f"temporal_coverage_{table}",
            passed=coverage >= 0.95,  # Allow 5% missing days
            expected=">= 95%",
            actual=f"{coverage:.1%}",
            details=f"{num_days} unique days"
        ))
        
    except Exception as e:
        results.append(QAResult(
            check_name=f"temporal_{table}",
            passed=False,
            expected="valid dates",
            actual="ERROR",
            details=str(e)
        ))
    
    cursor.close()
    return results


# =============================================================================
# SPATIAL BOUNDS
# =============================================================================

def check_spatial_bounds(
    conn,
    schema: str,
    table: str,
    lat_col: str,
    lng_col: str,
    bbox: dict  # min_lat, max_lat, min_lng, max_lng
) -> List[QAResult]:
    """Check coordinates are within expected bounding box."""
    results = []
    cursor = conn.cursor()
    
    try:
        cursor.execute(f"""
            SELECT 
                MIN({lat_col}) as min_lat,
                MAX({lat_col}) as max_lat,
                MIN({lng_col}) as min_lng,
                MAX({lng_col}) as max_lng,
                COUNT(*) as total,
                SUM(CASE WHEN {lat_col} BETWEEN {bbox['min_lat']} AND {bbox['max_lat']}
                         AND {lng_col} BETWEEN {bbox['min_lng']} AND {bbox['max_lng']}
                    THEN 1 ELSE 0 END) as in_bounds
            FROM {schema}.{table}
            WHERE {lat_col} IS NOT NULL AND {lng_col} IS NOT NULL
        """)
        row = cursor.fetchone()
        min_lat, max_lat, min_lng, max_lng, total, in_bounds = row
        
        in_bounds_pct = in_bounds / total if total > 0 else 0
        
        results.append(QAResult(
            check_name=f"spatial_bounds_{table}",
            passed=in_bounds_pct >= 0.99,  # Allow 1% outside
            expected=">= 99% in bounds",
            actual=f"{in_bounds_pct:.2%}",
            details=f"Lat: {min_lat:.2f}-{max_lat:.2f}, Lng: {min_lng:.2f}-{max_lng:.2f}"
        ))
        
    except Exception as e:
        results.append(QAResult(
            check_name=f"spatial_{table}",
            passed=False,
            expected="valid coords",
            actual="ERROR",
            details=str(e)
        ))
    
    cursor.close()
    return results


# =============================================================================
# DISTRIBUTION CHECKS
# =============================================================================

def check_speeding_distribution(
    conn,
    schema: str,
    expected_rate: Tuple[float, float]  # (min_rate, max_rate)
) -> QAResult:
    """Check speeding rate is within expected range."""
    cursor = conn.cursor()
    
    try:
        cursor.execute(f"""
            SELECT 
                AVG(CASE WHEN IS_SPEEDING THEN 1.0 ELSE 0.0 END) as speeding_rate
            FROM {schema}.FACT_TRUCK_TELEMETRY
            WHERE STATUS = 'MOVING'
        """)
        rate = cursor.fetchone()[0] or 0
        
        min_rate, max_rate = expected_rate
        passed = min_rate <= rate <= max_rate
        
        return QAResult(
            check_name="speeding_rate",
            passed=passed,
            expected=f"{min_rate:.1%} - {max_rate:.1%}",
            actual=f"{rate:.2%}",
            details="Speeding rate among moving points"
        )
        
    except Exception as e:
        return QAResult(
            check_name="speeding_rate",
            passed=False,
            expected=f"{expected_rate[0]:.1%} - {expected_rate[1]:.1%}",
            actual="ERROR",
            details=str(e)
        )
    finally:
        cursor.close()


def check_hos_violation_distribution(
    conn,
    schema: str,
    expected_rate: Tuple[float, float]
) -> QAResult:
    """Check HOS violation rate."""
    cursor = conn.cursor()
    
    try:
        cursor.execute(f"""
            SELECT 
                COUNT(DISTINCT CASE WHEN IS_HOS_VIOLATION THEN TRUCK_ID || '-' || TS::DATE END) as violation_days,
                COUNT(DISTINCT TRUCK_ID || '-' || TS::DATE) as total_days
            FROM {schema}.FACT_TRUCK_TELEMETRY
        """)
        violation_days, total_days = cursor.fetchone()
        rate = violation_days / total_days if total_days > 0 else 0
        
        min_rate, max_rate = expected_rate
        passed = min_rate <= rate <= max_rate
        
        return QAResult(
            check_name="hos_violation_rate",
            passed=passed,
            expected=f"{min_rate:.1%} - {max_rate:.1%}",
            actual=f"{rate:.2%}",
            details=f"{violation_days} truck-days with HOS violations"
        )
        
    except Exception as e:
        return QAResult(
            check_name="hos_violation_rate",
            passed=False,
            expected=f"{expected_rate[0]:.1%} - {expected_rate[1]:.1%}",
            actual="ERROR",
            details=str(e)
        )
    finally:
        cursor.close()


def check_detour_distribution(
    conn,
    schema: str,
    expected_rate: Tuple[float, float]
) -> QAResult:
    """Check detour rate among trips."""
    cursor = conn.cursor()
    
    try:
        cursor.execute(f"""
            SELECT 
                AVG(CASE WHEN IS_DETOUR THEN 1.0 ELSE 0.0 END) as detour_rate
            FROM (
                SELECT TRIP_ID, MAX(CASE WHEN IS_DETOUR THEN 1 ELSE 0 END) as IS_DETOUR
                FROM {schema}.FACT_TRUCK_TELEMETRY
                GROUP BY TRIP_ID
            )
        """)
        rate = cursor.fetchone()[0] or 0
        
        min_rate, max_rate = expected_rate
        passed = min_rate <= rate <= max_rate
        
        return QAResult(
            check_name="detour_rate",
            passed=passed,
            expected=f"{min_rate:.1%} - {max_rate:.1%}",
            actual=f"{rate:.2%}",
            details="Detour rate among trips"
        )
        
    except Exception as e:
        return QAResult(
            check_name="detour_rate",
            passed=False,
            expected=f"{expected_rate[0]:.1%} - {expected_rate[1]:.1%}",
            actual="ERROR",
            details=str(e)
        )
    finally:
        cursor.close()


# =============================================================================
# ROUTE QUALITY
# =============================================================================

def check_route_quality(
    conn,
    schema: str,
    max_point_gap_m: float = 2000
) -> QAResult:
    """
    Check route quality by measuring gaps between consecutive points.
    
    Good routes should have small gaps (road-following, not straight lines).
    """
    cursor = conn.cursor()
    
    try:
        cursor.execute(f"""
            WITH point_gaps AS (
                SELECT 
                    TRUCK_ID,
                    TRIP_ID,
                    TS,
                    LATITUDE,
                    LONGITUDE,
                    LAG(LATITUDE) OVER (PARTITION BY TRUCK_ID, TRIP_ID ORDER BY TS) as prev_lat,
                    LAG(LONGITUDE) OVER (PARTITION BY TRUCK_ID, TRIP_ID ORDER BY TS) as prev_lng
                FROM {schema}.FACT_TRUCK_TELEMETRY
                WHERE STATUS = 'MOVING'
            )
            SELECT 
                AVG(HAVERSINE(prev_lat, prev_lng, LATITUDE, LONGITUDE) * 1000) as avg_gap_m,
                PERCENTILE_CONT(0.95) WITHIN GROUP (ORDER BY HAVERSINE(prev_lat, prev_lng, LATITUDE, LONGITUDE) * 1000) as p95_gap_m
            FROM point_gaps
            WHERE prev_lat IS NOT NULL
        """)
        avg_gap, p95_gap = cursor.fetchone()
        
        passed = avg_gap <= max_point_gap_m and p95_gap <= max_point_gap_m * 3
        
        return QAResult(
            check_name="route_quality",
            passed=passed,
            expected=f"avg <= {max_point_gap_m}m",
            actual=f"avg={avg_gap:.0f}m, p95={p95_gap:.0f}m",
            details="Distance between consecutive telemetry points (lower = better road-following)"
        )
        
    except Exception as e:
        return QAResult(
            check_name="route_quality",
            passed=False,
            expected=f"avg <= {max_point_gap_m}m",
            actual="ERROR",
            details=str(e)
        )
    finally:
        cursor.close()


# =============================================================================
# COMPLETENESS CHECKS
# =============================================================================

def check_null_rates(
    conn,
    schema: str,
    table: str,
    critical_columns: List[str],
    max_null_rate: float = 0.01
) -> List[QAResult]:
    """Check critical columns have low null rates."""
    results = []
    cursor = conn.cursor()
    
    for col in critical_columns:
        try:
            cursor.execute(f"""
                SELECT 
                    COUNT(*) as total,
                    SUM(CASE WHEN {col} IS NULL THEN 1 ELSE 0 END) as nulls
                FROM {schema}.{table}
            """)
            total, nulls = cursor.fetchone()
            null_rate = nulls / total if total > 0 else 0
            
            results.append(QAResult(
                check_name=f"null_rate_{table}_{col}",
                passed=null_rate <= max_null_rate,
                expected=f"<= {max_null_rate:.1%}",
                actual=f"{null_rate:.2%}",
                details=f"{nulls:,} nulls in {col}"
            ))
            
        except Exception as e:
            results.append(QAResult(
                check_name=f"null_rate_{table}_{col}",
                passed=False,
                expected=f"<= {max_null_rate:.1%}",
                actual="ERROR",
                details=str(e)
            ))
    
    cursor.close()
    return results


# =============================================================================
# FULL QA SUITE
# =============================================================================

def run_full_qa(config: dict, connection_name: Optional[str] = None) -> List[QAResult]:
    """
    Run complete QA validation suite.
    
    Returns list of all QA results.
    """
    conn = get_snowflake_connection(connection_name)
    sf_config = config['snowflake']
    schema = f"{sf_config['database']}.{sf_config['schema']}"
    bbox = config['region']['bbox']
    
    time_config = config['time']
    start_date = time_config['start_date']
    from datetime import datetime, timedelta
    from dateutil.relativedelta import relativedelta
    end_date = (datetime.strptime(start_date, "%Y-%m-%d") + 
                relativedelta(months=time_config['duration_months']) - 
                timedelta(days=1)).strftime("%Y-%m-%d")
    
    all_results = []
    
    try:
        # 1. Row count checks
        logger.info("Running row count checks...")
        all_results.extend(check_row_counts(conn, schema, {
            'FACT_TRUCK_TELEMETRY': (1_000_000, 50_000_000),
            'DIM_TRUCK': (100, 10_000),
            'DIM_WAREHOUSE': (100, 100_000),
            'DIM_STOP': (100, 50_000)
        }))
        
        # 2. Temporal coverage
        logger.info("Running temporal coverage checks...")
        all_results.extend(check_temporal_coverage(
            conn, schema, 'FACT_TRUCK_TELEMETRY', 'TS',
            start_date, end_date
        ))
        
        # 3. Spatial bounds
        logger.info("Running spatial bounds checks...")
        all_results.extend(check_spatial_bounds(
            conn, schema, 'FACT_TRUCK_TELEMETRY',
            'LATITUDE', 'LONGITUDE', bbox
        ))
        
        # 4. Distribution checks
        logger.info("Running distribution checks...")
        all_results.append(check_speeding_distribution(
            conn, schema, (0.02, 0.15)  # 2-15% speeding rate
        ))
        all_results.append(check_hos_violation_distribution(
            conn, schema, (0.005, 0.05)  # 0.5-5% HOS violation rate
        ))
        all_results.append(check_detour_distribution(
            conn, schema, (0.05, 0.35)  # 5-35% detour rate
        ))
        
        # 5. Route quality
        logger.info("Running route quality checks...")
        all_results.append(check_route_quality(conn, schema))
        
        # 6. Null rate checks
        logger.info("Running null rate checks...")
        all_results.extend(check_null_rates(
            conn, schema, 'FACT_TRUCK_TELEMETRY',
            ['TRUCK_ID', 'TS', 'LATITUDE', 'LONGITUDE', 'SPEED_KMH']
        ))
        
    finally:
        conn.close()
    
    # Print summary
    passed = sum(1 for r in all_results if r.passed)
    failed = len(all_results) - passed
    
    logger.info(f"\n{'='*60}")
    logger.info(f"QA RESULTS: {passed} passed, {failed} failed")
    logger.info(f"{'='*60}")
    
    for r in all_results:
        status = "✓" if r.passed else "✗"
        logger.info(f"{status} {r.check_name}: {r.actual} (expected {r.expected})")
        if r.details and not r.passed:
            logger.info(f"   Details: {r.details}")
    
    return all_results


def qa_results_to_dataframe(results: List[QAResult]) -> pd.DataFrame:
    """Convert QA results to DataFrame for reporting."""
    return pd.DataFrame([
        {
            'check_name': r.check_name,
            'passed': r.passed,
            'expected': r.expected,
            'actual': r.actual,
            'details': r.details
        }
        for r in results
    ])

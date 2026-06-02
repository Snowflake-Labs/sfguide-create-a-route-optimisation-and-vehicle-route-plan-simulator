"""W1 / W2 query templates per variant.

W1 = point lookup    : WHERE ORIGIN_H3=? AND DEST_H3=? -> 1 row
W2 = group lookup    : WHERE ORIGIN_H3=?               -> all dests for that origin
"""

DB_SCHEMA = "BENCHMARK.BENCH_MATRIX"

VARIANTS = [
    # (variant_id, table_name, warehouse, label)
    ("A_standard",       "BENCH_MATRIX_STD",         "BENCH_STD_WH", "Standard"),
    ("C_clustered",      "BENCH_MATRIX_CLUSTERED",   "BENCH_STD_WH", "Clustered"),
    # D_hybrid excluded at 3.2B-row scale: Unistore bulk INSERT did not complete
    # within ~100 min on LARGE (hybrid bulk-load throughput is the bottleneck).
    ("E_interactive",    "BENCH_MATRIX_INTERACTIVE", "BENCH_INT_WH", "Interactive (Gen2)"),
]

def w1_sql(table: str) -> str:
    return (
        f"SELECT TRAVEL_TIME_SECONDS, TRAVEL_DISTANCE_METERS "
        f"FROM {DB_SCHEMA}.{table} "
        f"WHERE ORIGIN_H3 = %s AND DEST_H3 = %s"
    )

def w2_sql(table: str) -> str:
    return (
        f"SELECT DEST_H3, TRAVEL_TIME_SECONDS, TRAVEL_DISTANCE_METERS "
        f"FROM {DB_SCHEMA}.{table} "
        f"WHERE ORIGIN_H3 = %s"
    )

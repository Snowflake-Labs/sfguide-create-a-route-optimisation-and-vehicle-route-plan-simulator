"""Travel-Matrix Access Benchmark.

Runs W1 (point lookup) and W2 (group lookup) across 5 table variants on
a copy of the Germany / driving-hgv / RES6 matrix. Writes one CSV row per
query plus a markdown summary with p50/p95/p99 latencies.

Usage:
    SNOWFLAKE_CONNECTION_NAME=<conn> python run_benchmark.py
        [--warmup 50] [--w1 1000] [--w2 200]
"""

import argparse
import csv
import os
import random
import statistics
import sys
import time
from pathlib import Path

import snowflake.connector

from workloads import VARIANTS, w1_sql, w2_sql

RESULTS_DIR = Path(__file__).resolve().parent.parent / "results"
RESULTS_DIR.mkdir(parents=True, exist_ok=True)
CSV_PATH = RESULTS_DIR / "bench_results.csv"
SUMMARY_PATH = RESULTS_DIR / "summary.md"

QUERY_TAG = (
    '{"origin":"sf_sit-is-fleet","name":"oss-matrix-access-benchmark",'
    '"version":{"major":1,"minor":0},"attributes":{"is_quickstart":0,"source":"python"}}'
)


def get_connection():
    name = os.getenv("SNOWFLAKE_CONNECTION_NAME") or "default"
    return snowflake.connector.connect(connection_name=name)


def fetch_probes(conn):
    cur = conn.cursor()
    cur.execute(
        "SELECT ORIGIN_H3, DEST_H3 FROM OPENROUTESERVICE_APP.BENCH_MATRIX.BENCH_PROBES_W1 ORDER BY probe_id"
    )
    w1 = cur.fetchall()
    cur.execute(
        "SELECT ORIGIN_H3 FROM OPENROUTESERVICE_APP.BENCH_MATRIX.BENCH_PROBES_W2 ORDER BY probe_id"
    )
    w2 = [r[0] for r in cur.fetchall()]
    cur.close()
    return w1, w2


def use_warehouse(conn, wh: str):
    cur = conn.cursor()
    cur.execute(f"USE WAREHOUSE {wh}")
    cur.execute(f"ALTER WAREHOUSE {wh} RESUME IF SUSPENDED")
    cur.close()


def run_workload(conn, table, sql, probes, warmup, label):
    """Run warm-up (timings discarded) then measurement batch."""
    cur = conn.cursor()

    warm_set = random.sample(probes, min(warmup, len(probes)))
    for p in warm_set:
        cur.execute(sql, p if isinstance(p, tuple) else (p,))
        cur.fetchall()

    rows = []
    for p in probes:
        params = p if isinstance(p, tuple) else (p,)
        t0 = time.perf_counter()
        cur.execute(sql, params)
        result = cur.fetchall()
        t1 = time.perf_counter()
        rows.append({
            "table": table,
            "client_ms": (t1 - t0) * 1000.0,
            "row_count": len(result),
            "query_id": cur.sfqid,
        })
    cur.close()
    return rows


def percentile(values, q):
    if not values:
        return float("nan")
    s = sorted(values)
    k = (len(s) - 1) * q
    f = int(k)
    c = min(f + 1, len(s) - 1)
    return s[f] + (s[c] - s[f]) * (k - f)


def write_csv(all_rows):
    fieldnames = ["variant_id", "variant_label", "workload", "table", "client_ms", "row_count", "query_id"]
    with CSV_PATH.open("w", newline="") as f:
        w = csv.DictWriter(f, fieldnames=fieldnames)
        w.writeheader()
        for r in all_rows:
            w.writerow(r)


def write_summary(all_rows):
    lines = [
        "# Matrix Access Benchmark - Summary",
        "",
        f"Generated: {time.strftime('%Y-%m-%d %H:%M:%S %Z')}",
        f"Source: `OPENROUTESERVICE_APP.TRAVEL_MATRIX.GERMANY_DRIVING_HGV_MATRIX_RES6` (~121 M rows, ~0.71 GB).",
        "",
        "Latencies are client-measured wall time per query (warm-up excluded).",
        "Result cache disabled at session level.",
        "",
        "| Variant | Workload | N | p50 ms | p95 ms | p99 ms | mean ms | mean rows |",
        "| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |",
    ]
    by_key = {}
    for r in all_rows:
        by_key.setdefault((r["variant_label"], r["workload"]), []).append(r)
    order = []
    seen = set()
    for r in all_rows:
        k = (r["variant_label"], r["workload"])
        if k not in seen:
            order.append(k)
            seen.add(k)
    for k in order:
        rows = by_key[k]
        lat = [r["client_ms"] for r in rows]
        rc = [r["row_count"] for r in rows]
        lines.append(
            f"| {k[0]} | {k[1]} | {len(rows)} | "
            f"{percentile(lat,0.5):.1f} | {percentile(lat,0.95):.1f} | {percentile(lat,0.99):.1f} | "
            f"{statistics.mean(lat):.1f} | {statistics.mean(rc):.0f} |"
        )
    SUMMARY_PATH.write_text("\n".join(lines) + "\n")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--warmup", type=int, default=50)
    ap.add_argument("--w1", type=int, default=1000, help="cap on W1 probes")
    ap.add_argument("--w2", type=int, default=200, help="cap on W2 probes")
    args = ap.parse_args()

    random.seed(42)

    conn = get_connection()
    cur = conn.cursor()
    cur.execute(f"ALTER SESSION SET QUERY_TAG = '{QUERY_TAG}'")
    cur.execute("ALTER SESSION SET USE_CACHED_RESULT = FALSE")
    cur.close()

    w1_probes_full, w2_probes_full = fetch_probes(conn)
    w1_probes = w1_probes_full[: args.w1]
    w2_probes = w2_probes_full[: args.w2]
    print(f"Loaded {len(w1_probes)} W1 probes, {len(w2_probes)} W2 probes.")

    all_rows = []
    for variant_id, table, warehouse, label in VARIANTS:
        print(f"\n=== Variant {variant_id} ({label}) on {warehouse} ===")
        use_warehouse(conn, warehouse)

        # W1
        print(f"  W1 point lookup x {len(w1_probes)} ...")
        t0 = time.perf_counter()
        rows = run_workload(conn, table, w1_sql(table), w1_probes, args.warmup, label)
        for r in rows:
            r["variant_id"] = variant_id
            r["variant_label"] = label
            r["workload"] = "W1_point"
        all_rows.extend(rows)
        print(f"    done in {time.perf_counter()-t0:.1f}s")

        # W2
        print(f"  W2 group lookup x {len(w2_probes)} ...")
        t0 = time.perf_counter()
        rows = run_workload(conn, table, w2_sql(table), w2_probes, min(args.warmup, len(w2_probes)//2), label)
        for r in rows:
            r["variant_id"] = variant_id
            r["variant_label"] = label
            r["workload"] = "W2_group"
        all_rows.extend(rows)
        print(f"    done in {time.perf_counter()-t0:.1f}s")

    write_csv(all_rows)
    write_summary(all_rows)
    print(f"\nWrote {CSV_PATH}")
    print(f"Wrote {SUMMARY_PATH}")
    conn.close()


if __name__ == "__main__":
    sys.exit(main())

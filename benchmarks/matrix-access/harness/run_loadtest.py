"""Phase-2 load test: concurrency sweep across all matrix variants.

Runs each (variant, workload, concurrency) cell for a fixed wall-clock
duration using a thread-pool of N workers, each with its own Snowflake
connection. Measures achieved QPS and p50/p95/p99 client latency.

Usage:
    SNOWFLAKE_CONNECTION_NAME=fleet_test_evals python run_loadtest.py
        [--duration 30] [--warmup 5] [--concurrencies 1,10,50,100]
"""

import argparse
import collections
import csv
import os
import statistics
import sys
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import snowflake.connector

from workloads import VARIANTS, w1_sql, w2_sql

RESULTS_DIR = Path(__file__).resolve().parent.parent / "results"
RESULTS_DIR.mkdir(parents=True, exist_ok=True)
CSV_PATH = RESULTS_DIR / "bench_loadtest.csv"
SUMMARY_PATH = RESULTS_DIR / "loadtest_summary.md"

QUERY_TAG = (
    '{"origin":"sf_sit-is-fleet","name":"oss-matrix-access-benchmark",'
    '"version":{"major":1,"minor":0},"attributes":{"is_quickstart":0,"source":"python-loadtest"}}'
)
CONN_NAME = os.getenv("SNOWFLAKE_CONNECTION_NAME") or "fleet_test_evals"


def make_conn():
    c = snowflake.connector.connect(connection_name=CONN_NAME)
    cur = c.cursor()
    cur.execute(f"ALTER SESSION SET QUERY_TAG = '{QUERY_TAG}'")
    cur.execute("ALTER SESSION SET USE_CACHED_RESULT = FALSE")
    cur.close()
    return c


def fetch_probes(conn):
    cur = conn.cursor()
    cur.execute("SELECT ORIGIN_H3, DEST_H3 FROM OPENROUTESERVICE_APP.BENCH_MATRIX.BENCH_PROBES_W1 ORDER BY probe_id")
    w1 = cur.fetchall()
    cur.execute("SELECT ORIGIN_H3 FROM OPENROUTESERVICE_APP.BENCH_MATRIX.BENCH_PROBES_W2 ORDER BY probe_id")
    w2 = [r[0] for r in cur.fetchall()]
    cur.close()
    return w1, w2


def worker_loop(conn, warehouse, sql, probes, stop_event, warmup_end, results_list, lock):
    cur = conn.cursor()
    cur.execute(f"USE WAREHOUSE {warehouse}")
    idx = 0
    n_probes = len(probes)
    while not stop_event.is_set():
        p = probes[idx % n_probes]
        params = p if isinstance(p, tuple) else (p,)
        error_msg = None
        t0 = time.perf_counter()
        try:
            cur.execute(sql, params)
            rows = cur.fetchall()
            row_count = len(rows)
        except Exception as e:
            row_count = 0
            error_msg = str(e)[:200]
        t1 = time.perf_counter()
        ts = time.time()
        if ts >= warmup_end:
            with lock:
                results_list.append({
                    "client_ms": (t1 - t0) * 1000.0,
                    "row_count": row_count,
                    "error": error_msg,
                    "query_id": getattr(cur, "sfqid", ""),
                })
        idx += 1
    cur.close()


def run_cell(conns, warehouse, sql, probes, concurrency, warmup_s, duration_s):
    stop_event = threading.Event()
    lock = threading.Lock()
    results_list = []
    warmup_end = time.time() + warmup_s

    with ThreadPoolExecutor(max_workers=concurrency) as pool:
        futures = []
        for i in range(concurrency):
            c = conns[i % len(conns)]
            futures.append(
                pool.submit(worker_loop, c, warehouse, sql, probes, stop_event, warmup_end, results_list, lock)
            )
        time.sleep(warmup_s + duration_s)
        stop_event.set()
        for f in futures:
            f.result()

    return results_list


def percentile(values, q):
    if not values:
        return float("nan")
    s = sorted(values)
    k = (len(s) - 1) * q
    f = int(k)
    c = min(f + 1, len(s) - 1)
    return s[f] + (s[c] - s[f]) * (k - f)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--duration", type=int, default=30, help="measurement window per cell (seconds)")
    ap.add_argument("--warmup", type=int, default=5, help="warm-up period per cell (seconds)")
    ap.add_argument("--concurrencies", type=str, default="1,10,50,100", help="comma-separated concurrency levels")
    args = ap.parse_args()
    concurrencies = [int(x) for x in args.concurrencies.split(",")]
    max_conc = max(concurrencies)

    print(f"Creating {max_conc} connections ...")
    conns = [make_conn() for _ in range(max_conc)]
    print(f"  done. Fetching probes ...")
    w1_probes, w2_probes = fetch_probes(conns[0])
    print(f"  {len(w1_probes)} W1 probes, {len(w2_probes)} W2 probes.")

    all_rows = []
    csv_fieldnames = ["variant_id", "variant_label", "workload", "concurrency",
                      "client_ms", "row_count", "query_id", "error"]

    for variant_id, table, warehouse, label in VARIANTS:
        for wl_name, sql_fn, probes in [("W1_point", w1_sql, w1_probes), ("W2_group", w2_sql, w2_probes)]:
            sql = sql_fn(table)
            for conc in concurrencies:
                tag = f"{label}/{wl_name}/c={conc}"
                print(f"  {tag} ...", end=" ", flush=True)
                t0 = time.perf_counter()
                cell_results = run_cell(conns[:conc], warehouse, sql, probes, conc, args.warmup, args.duration)
                elapsed = time.perf_counter() - t0
                n = len(cell_results)
                errs = sum(1 for r in cell_results if r["error"])
                lat = [r["client_ms"] for r in cell_results if not r["error"]]
                qps = n / args.duration if args.duration > 0 else 0
                p50 = percentile(lat, 0.5) if lat else float("nan")
                p95 = percentile(lat, 0.95) if lat else float("nan")
                print(f"n={n} qps={qps:.1f} p50={p50:.0f}ms p95={p95:.0f}ms errs={errs} [{elapsed:.1f}s]")
                for r in cell_results:
                    r["variant_id"] = variant_id
                    r["variant_label"] = label
                    r["workload"] = wl_name
                    r["concurrency"] = conc
                all_rows.extend(cell_results)

    print(f"\nWriting {CSV_PATH} ...")
    with CSV_PATH.open("w", newline="") as f:
        w = csv.DictWriter(f, fieldnames=csv_fieldnames)
        w.writeheader()
        for r in all_rows:
            w.writerow(r)

    print(f"Writing {SUMMARY_PATH} ...")
    write_summary(all_rows, concurrencies, args.duration)
    print("Done.")

    for c in conns:
        try:
            c.close()
        except Exception:
            pass


def write_summary(all_rows, concurrencies, duration):
    lines = [
        "# Matrix Access Load Test - Summary",
        "",
        f"Generated: {time.strftime('%Y-%m-%d %H:%M:%S %Z')}",
        f"Source: `GERMANY_DRIVING_HGV_MATRIX_RES6` (~121 M rows, 0.71 GB compressed).",
        f"Measurement window: {duration}s per cell. Result cache disabled. Bind variables.",
        "",
    ]

    by_key = collections.defaultdict(list)
    for r in all_rows:
        by_key[(r["variant_label"], r["workload"], r["concurrency"])].append(r)

    for wl in ["W1_point", "W2_group"]:
        lines.append(f"## {wl}")
        lines.append("")
        header_cols = " | ".join([f"QPS (c={c}) | p50 | p95 | p99 | err%" for c in concurrencies])
        lines.append(f"| Variant | {header_cols} |")
        sep_cols = " | ".join(["---: | ---: | ---: | ---: | ---:" for _ in concurrencies])
        lines.append(f"| --- | {sep_cols} |")

        for _, _, _, label in VARIANTS:
            cols = []
            for conc in concurrencies:
                rows = by_key.get((label, wl, conc), [])
                n = len(rows)
                errs = sum(1 for r in rows if r["error"])
                lat = [r["client_ms"] for r in rows if not r["error"]]
                qps = n / duration if duration > 0 else 0
                err_pct = (errs / n * 100) if n > 0 else 0
                p50 = percentile(lat, 0.5) if lat else float("nan")
                p95 = percentile(lat, 0.95) if lat else float("nan")
                p99 = percentile(lat, 0.99) if lat else float("nan")
                cols.append(f"{qps:.1f} | {p50:.0f} | {p95:.0f} | {p99:.0f} | {err_pct:.1f}")
            lines.append(f"| {label} | {' | '.join(cols)} |")
        lines.append("")

    SUMMARY_PATH.write_text("\n".join(lines) + "\n")


if __name__ == "__main__":
    sys.exit(main())

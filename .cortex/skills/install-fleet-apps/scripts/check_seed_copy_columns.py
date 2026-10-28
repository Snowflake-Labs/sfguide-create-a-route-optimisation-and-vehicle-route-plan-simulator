#!/usr/bin/env python3
"""check_seed_copy_columns.py - every seed COPY binds columns by NAME.

A transform COPY with no target column list maps by position, so an older
pre-existing table shape broke the loader mid-file on a reused account
(ROUTE_OPTIMIZATION.LOOKUP: "expecting 10 but got 13") and every later seed
table was silently never created. See seed_contract.py.
"""
import sys

from seed_contract import copies, table_shapes, violations


def main():
    problems = violations()
    n = len(copies())
    if problems:
        print(f"check_seed_copy_columns: FAIL - {len(problems)} problem(s) in {n} COPY statements")
        for p in problems:
            print("  " + p)
        return 1
    print(f"check_seed_copy_columns: OK - {n} COPY statements name-bound, "
          f"{len(table_shapes())} table shapes declared")
    return 0


if __name__ == "__main__":
    sys.exit(main())

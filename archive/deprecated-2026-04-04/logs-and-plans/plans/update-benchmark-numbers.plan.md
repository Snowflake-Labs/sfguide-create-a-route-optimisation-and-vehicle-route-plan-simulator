# Plan: Update Benchmark Numbers

Replace estimated matrix build times with the actual Berlin RES8 benchmark across the reference docs we just updated.

## Actual benchmark
- **Region:** Berlin, RES8
- **Hexagons:** 2,611
- **Pairs:** ~6.8M (6,814,710)
- **Build time:** 6 minutes (down from 163 min pre-optimization)

## Changes

### 1. references/troubleshooting.md

In the "Matrix Build Slow for City Regions" section, replace the estimated improvement line:
- Old: `Berlin RES8 went from ~163min to ~15-25min`
- New: `Berlin RES8 went from 163min to 6min (2,611 hexagons, ~6.8M pairs)`

### 2. references/available-functions.md

In the "Gateway Concurrency" subsection under Matrix Builder Architecture, add a benchmark reference line after the throughput note.

### 3. references/snowflake-scripting-guidelines.md

In the "Matrix parallel workers formula" subsection of section 12, add a concrete timing note so readers can estimate build times for their regions.

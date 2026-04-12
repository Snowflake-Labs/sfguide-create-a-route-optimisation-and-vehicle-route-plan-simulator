# Travel Time Matrix — Architecture

## End-to-End Pipeline

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                          SNOWFLAKE ACCOUNT                                  │
│                                                                             │
│  ┌───────────────────────────────────────────────────────────────────────┐  │
│  │                     STEP 1: H3 GRID GENERATION                       │  │
│  │                                                                       │  │
│  │   Region bounding box ──► H3_POINT_TO_CELL_STRING() ──► H3 Hex Tbls │  │
│  │   (any geography)         at chosen resolutions        (with lat/lon)│  │
│  └───────────────────────────┬───────────────────────────────────────────┘  │
│                              │                                              │
│                              ▼                                              │
│  ┌───────────────────────────────────────────────────────────────────────┐  │
│  │                     STEP 2: WORK QUEUE BUILD                         │  │
│  │                                                                       │  │
│  │   For each origin hex:                                                │  │
│  │   ┌──────────┐    H3_GRID_DISK()    ┌──────────────────────────┐     │  │
│  │   │ Origin   │ ──────────────────►   │ Neighbor destinations    │     │  │
│  │   │ H3 hex   │   (radius by res)    │ + packed coord arrays    │     │  │
│  │   └──────────┘                       │ + SEQ_ID for chunking   │     │  │
│  │                                      └──────────────────────────┘     │  │
│  │                                                                       │  │
│  │   <REGION>_WORK_QUEUE_RES<N>: varies by region + resolution          │  │
│  └───────────────────────────┬───────────────────────────────────────────┘  │
│                              │                                              │
│                              ▼                                              │
│  ┌───────────────────────────────────────────────────────────────────────┐  │
│  │                STEP 3: PARALLEL WORKER EXECUTION                     │  │
│  │                                                                       │  │
│  │   ROUTING_ANALYTICS Warehouse (XSMALL x N multi-cluster)             │  │
│  │   ┌─────────┐ ┌─────────┐ ┌─────────┐           ┌─────────┐         │  │
│  │   │Worker 01│ │Worker 02│ │Worker 03│    ...    │Worker N │         │  │
│  │   │seq 1-M  │ │seq M-2M │ │seq 2M-3M│           │seq...-T │         │  │
│  │   └────┬────┘ └────┬────┘ └────┬────┘           └────┬────┘         │  │
│  │        │            │            │                     │              │  │
│  │        │     Each worker calls MATRIX_TABULAR()        │              │  │
│  │        │     in batches with retry + backoff            │              │  │
│  │        ▼            ▼            ▼                     ▼              │  │
│  │   ┌──────────────────────────────────────────────────────┐           │  │
│  │   │              ORS NATIVE APP                          │           │  │
│  │   │   ┌──────────────────────────────────────────────┐   │           │  │
│  │   │   │  COMPUTE POOL (N x HIGHMEM_X64_M nodes)     │   │           │  │
│  │   │   │                                              │   │           │  │
│  │   │   │  ┌─────────┐  ┌─────────┐     ┌─────────┐   │   │           │  │
│  │   │   │  │ ORS #1  │  │ ORS #2  │ ... │ ORS #N  │   │   │           │  │
│  │   │   │  │(routing │  │(routing │     │(routing │   │   │           │  │
│  │   │   │  │ engine) │  │ engine) │     │ engine) │   │   │           │  │
│  │   │   │  └────┬────┘  └────┬────┘     └────┬────┘   │   │           │  │
│  │   │   │       │            │                │        │   │           │  │
│  │   │   │  ┌────┴────┐  ┌────┴────┐     ┌────┴────┐   │   │           │  │
│  │   │   │  │  GW #1  │  │  GW #2  │ ... │  GW #N  │   │   │           │  │
│  │   │   │  │(gateway)│  │(gateway)│     │(gateway)│   │   │           │  │
│  │   │   │  └─────────┘  └─────────┘     └─────────┘   │   │           │  │
│  │   │   └──────────────────────────────────────────────┘   │           │  │
│  │   └──────────────────────────────────────────────────────┘           │  │
│  │        │            │            │                     │              │  │
│  │        ▼            ▼            ▼                     ▼              │  │
│  │   ┌──────────────────────────────────────────────────────┐           │  │
│  │   │            RAW STAGING TABLES (VARIANT)              │           │  │
│  │   │  <REGION>_MATRIX_RAW_RES<N> (VARIANT payload)       │           │  │
│  │   └──────────────────────────────────────────────────────┘           │  │
│  └───────────────────────────┬───────────────────────────────────────────┘  │
│                              │                                              │
│                              ▼                                              │
│  ┌───────────────────────────────────────────────────────────────────────┐  │
│  │                    STEP 4: FLATTEN (Post-Processing)                  │  │
│  │                                                                       │  │
│  │   FLATTEN_WH (XLARGE, auto-suspend 60s)                               │  │
│  │                                                                       │  │
│  │   Raw VARIANT ──► LATERAL FLATTEN() ──► Structured travel time rows   │  │
│  │                                                                       │  │
│  │   <REGION>_TRAVEL_TIME_RES<N>: origin/dest H3 + time + distance      │  │
│  └───────────────────────────┬───────────────────────────────────────────┘  │
│                              │                                              │
│                              ▼                                              │
│  ┌───────────────────────────────────────────────────────────────────────┐  │
│  │                    CONSUMPTION LAYER                                  │  │
│  │                                                                       │  │
│  │   ┌─────────────────────┐    ┌─────────────────────────────────┐     │  │
│  │   │  Streamlit Dashboard │    │  VROOM Route Optimization       │     │  │
│  │   │  Sub-second lookups │    │  Pre-computed matrices for VRP  │     │  │
│  │   └─────────────────────┘    └─────────────────────────────────┘     │  │
│  └───────────────────────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────────────────┘
```

## Task DAG (Automated Pipeline)

```
                    EXECUTE TASK (trigger)
                           │
            ┌──────────────┼──────────────┐
            ▼              ▼              ▼
   ┌────────────────┐ ┌────────────┐ ┌────────────────┐
   │ BUILD_QUEUE    │ │ BUILD_QUEUE│ │ BUILD_QUEUE    │   One root task
   │ <REGION>_RES_A │ │ _RES_B     │ │ _RES_C         │   per resolution
   └───────┬────────┘ └─────┬──────┘ └───────┬────────┘
           │                │                 │
     ┌─────┼─────┐    ┌────┼────┐      ┌────┼────┐
     ▼     ▼     ▼    ▼    ▼    ▼      ▼    ▼    ▼
   ┌───┐ ┌───┐ ┌───┐┌───┐┌───┐┌───┐ ┌───┐┌───┐┌───┐
   │W01│ │W02│…│W_N││W01││W02│…│W_N│ │W01││W02│…│W_N│    N workers
   └─┬─┘ └─┬─┘ └─┬─┘└─┬─┘└─┬─┘└─┬─┘ └─┬─┘└─┬─┘└─┬─┘    per resolution
     │     │     │    │    │    │     │    │    │
     └─────┼─────┘    └────┼────┘     └────┼────┘
           │                │                │
           ▼                ▼                ▼
   ┌────────────────┐ ┌────────────┐ ┌────────────────┐
   │ FLATTEN        │ │ FLATTEN    │ │ FLATTEN         │   Fan-in: fires
   │ <REGION>_RES_A │ │ _RES_B     │ │ _RES_C          │   when ALL workers
   │ (XLARGE WH)    │ │(XLARGE WH) │ │ (XLARGE WH)    │   complete
   └────────────────┘ └────────────┘ └────────────────┘
```

## Infrastructure Layout

```
  WAREHOUSES                          COMPUTE POOL
  ══════════                          ════════════
  
  ROUTING_ANALYTICS                   HIGHMEM_X64_M x N nodes
  ├── XSMALL x N clusters            ├── ORS Service x N instances
  ├── Multi-cluster (auto-scale)     ├── Gateway x N instances
  ├── Workers are I/O bound          ├── VROOM Service x 1 instance
  └── AUTO_SUSPEND = 300s            └── Graphs loaded in memory
  
  FLATTEN_WH                          Scale Guide:
  ├── XLARGE (single cluster)           City:    N = 3
  ├── Bulk FLATTEN needs compute        Metro:   N = 5
  └── AUTO_SUSPEND = 60s               State:   N = 10
                                        Country: N = 20
```

## Timing Estimates by Region Size

| Region | Origins (all res) | Pairs | Workers | ORS Instances | Est. Time |
|--------|-------------------|-------|---------|---------------|-----------|
| City (1 res) | ~50K | ~6.6M | 3 | 3 | ~5 min |
| Metro (2 res) | ~200K | ~100M | 5 | 5 | ~30 min |
| State (3 res) | ~10M | ~1.94B | 10 | 10 | ~6.5 hrs |
| Country (3 res) | ~50M | ~10B | 20 | 20 | ~34 hrs |

### What Affects Duration

| Factor | Impact | Recommendation |
|--------|--------|----------------|
| ORS instance count | Linear speedup up to ~20 | Match to compute pool nodes |
| Gateway instance count | Must match ORS count | Was a bottleneck at 3 when ORS had 10 |
| Warehouse size | No impact (I/O bound) | XSMALL is sufficient |
| Warehouse cluster count | Must match worker count | N clusters for N workers |
| Batch size | Affects error rate, not speed | Auto-tuned by resolution |
| ORS graph rebuild | ~40-60s after restart | Wait before launching workers |

### ORS Throughput

| Metric | Per Instance | 3 Instances | 10 Instances | 20 Instances |
|--------|-------------|-------------|--------------|--------------|
| MATRIX_TABULAR calls/sec | ~67.5 | ~200 | ~675 | ~1,350 |

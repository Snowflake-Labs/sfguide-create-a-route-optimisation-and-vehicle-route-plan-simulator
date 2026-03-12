# Travel Time Matrix — Costing Exercise

## Reference Implementation

Computed **1.94 billion travel time pairs** across all of California at 3 H3 resolutions in **~6.5 hours**.

| Resolution | Origins | Avg Dests/Origin | Travel Time Pairs |
|---|---|---|---|
| RES7 (36km strategic) | 177,346 | 1,567 | 285,566,876 |
| RES8 (4.6km mid-range) | 1,202,348 | 438 | 519,528,661 |
| RES9 (1.2km last-mile) | 8,557,513 | 132 | ~1,130,000,000 |
| **Total** | **9,937,207** | | **~1,940,000,000** |

## Infrastructure

| Resource | Spec | Credits/hr | Purpose |
|---|---|---|---|
| ROUTING_ANALYTICS | XSMALL, 10 clusters (multi-cluster) | 10 | 30 parallel workers (10 per resolution) |
| Compute Pool | HIGHMEM_X64_M, 10 nodes | 10 | ORS + Gateway instances (10 each) |
| FLATTEN_WH | XLARGE, auto-suspend 60s | 16 | Bulk FLATTEN post-processing |

## Cost Breakdown (California — 1.94B pairs)

| Resource | Credits/hr | Hours | Credits | Notes |
|---|---|---|---|---|
| Warehouse (XSMALL × 10 clusters) | 10 | 6.5 | **65** | Workers sending API calls to ORS |
| Compute Pool (10 nodes) | 10 | 6.5 | **65** | ORS routing engine + gateway |
| Flatten Warehouse (XLARGE) | 16 | ~0.1 | **2** | ~2 min per resolution, 3 resolutions |
| **Total** | | **6.5 hrs** | **132 credits** | |

### Cost per unit

| Metric | Value |
|---|---|
| Total credits | 132 |
| Cost at $3/credit (on-demand) | ~$396 |
| Cost per billion pairs | ~68 credits / ~$204 |
| Cost per million pairs | ~0.068 credits / ~$0.20 |
| Cost per origin processed | ~0.000013 credits |

## Scaling Estimates

### By Geography

| Geography | Est. Origins (all 3 res) | Est. Pairs | Est. Credits | Est. Hours |
|---|---|---|---|---|
| Single metro area (e.g., LA) | ~1M | ~200M | ~14 | ~1 |
| California (reference) | ~10M | ~1.94B | ~132 | ~6.5 |
| US West Coast (CA+OR+WA) | ~25M | ~5B | ~340 | ~17 |
| Contiguous US | ~200M | ~40B | ~2,700 | ~130 |

### By Resolution (running a single resolution only)

| Resolution | Pairs/Origin | Credits/M origins | Wall-clock per M origins |
|---|---|---|---|
| RES7 (strategic) | ~1,567 | ~7 | ~20 min |
| RES8 (mid-range) | ~438 | ~5 | ~15 min |
| RES9 (last-mile) | ~132 | ~9 | ~25 min |

RES9 has more origins but fewer destinations each, so per-origin is fast but total volume is high.

### By Infrastructure Scale

| Config | Clusters | ORS Nodes | Credits/hr | Relative Speed |
|---|---|---|---|---|
| Small (dev/test) | 3 | 3 | 6 | 0.3× |
| Medium | 5 | 5 | 10 | 0.5× |
| **Reference (recommended)** | **10** | **10** | **20** | **1×** |
| Large | 20 | 20 | 40 | ~1.8× |

Scaling is roughly linear up to ~10 nodes, then diminishing returns due to ORS graph contention.

## Cost Optimization Tips

1. **Use XSMALL warehouse**: Workers are I/O-bound (waiting for ORS), not compute-bound. XSMALL costs 16× less than MEDIUM per cluster with no performance impact.

2. **Auto-suspend aggressively**: Set `AUTO_SUSPEND = 60` on FLATTEN_WH (used briefly per resolution). Set `AUTO_SUSPEND = 300` on ROUTING_ANALYTICS.

3. **Run all resolutions concurrently**: Starting RES7/8/9 together means ORS nodes serve all three. Total wall-clock is dictated by the slowest (RES9), not the sum.

4. **Scale down immediately after**: Reduce compute pool to MIN_NODES=1 and warehouse to single cluster when done. Credits burn while idle.

5. **Resume-safe workers**: If cost is a concern, you can stop and restart workers at any time. They resume from the last completed SEQ_ID — no wasted work.

6. **Right-size the compute pool**: HIGHMEM_X64_M is required for ORS graph loading. Don't use larger node types — more nodes is better than bigger nodes.

## Business Value: Alternative Approach Comparison

### Google Maps Distance Matrix API

Google charges **per element** (one origin-destination pair). Pricing from the Google Maps Platform pricing list:

| Tier | Price per 1,000 elements | 1.94B pairs cost |
|---|---|---|
| Essentials (0-100K/mo) | $5.00 | N/A (rate-limited) |
| Pro (0-100K/mo) | $10.00 | N/A (rate-limited) |
| Enterprise (0-100K/mo) | $15.00 | N/A (rate-limited) |

Google's Distance Matrix API has a limit of **100 elements per request** and rate limits per minute. At the best bulk pricing (~$5 per 1,000 elements):

| | Google Maps | ORS on Snowflake |
|---|---|---|
| Cost for 1.94B pairs | **$9,700,000** | **$396** |
| Time to complete | Months (rate-limited) | 6.5 hours |
| Data residency | Google Cloud | Your Snowflake account |
| Ongoing query cost | Per-call pricing | $0 (pre-computed) |

**ORS on Snowflake is ~24,500× cheaper than Google Maps for this workload.**

Even at Google's highest volume discount tiers, the cost would still be in the millions. Google's API is designed for real-time single-request use, not bulk pre-computation at this scale.

### Mapbox / HERE / TomTom APIs

Similar SaaS routing APIs follow comparable pricing models:

| Provider | Approx. per 1,000 elements | 1.94B pairs est. cost |
|---|---|---|
| Google Maps | $5.00 - $15.00 | $9.7M - $29.1M |
| Mapbox | $5.00 - $10.00 | $9.7M - $19.4M |
| HERE | $1.00 - $5.00 | $1.9M - $9.7M |
| TomTom | $2.00 - $8.00 | $3.9M - $15.5M |
| **ORS on Snowflake** | **$0.0002** | **$396** |

All SaaS APIs share the same fundamental problem: they're priced for real-time, per-request use. Pre-computing billions of pairs is not their use case.

### Self-Hosted ORS on Spark (AWS EMR)

A Spark-based approach would require self-hosting ORS and orchestrating API calls from Spark workers. Here's a comparable setup:

**AWS EMR cluster (10 nodes):**
- Instance: r5.2xlarge (8 vCPU, 64 GB) — needed for ORS graph
- On-demand: $0.504/hr per instance
- EMR surcharge: $0.105/hr per instance
- 10 nodes × $0.609/hr = **$6.09/hr**

**Self-hosted ORS instances (10 nodes):**
- Instance: r5.2xlarge for ORS containers
- 10 nodes × $0.504/hr = **$5.04/hr**

**Additional AWS costs:**
- EBS storage for ORS graphs: ~$0.50/hr
- S3 for results: ~$0.10/hr
- Data transfer: ~$0.50/hr

| Component | Cost/hr | 6.5 hrs |
|---|---|---|
| EMR Spark cluster (10× r5.2xlarge) | $6.09 | $39.59 |
| ORS instances (10× r5.2xlarge) | $5.04 | $32.76 |
| EBS, S3, data transfer | $1.10 | $7.15 |
| **Total** | **$12.23** | **$79.50** |

**But this ignores the hidden costs:**

| Hidden Cost | Spark/AWS | Snowflake + ORS Native App |
|---|---|---|
| Infrastructure setup | Days to weeks | Minutes (native app install) |
| ORS deployment & config | Manual Docker/K8s | Managed by native app |
| Cluster management | You manage scaling, failures | Snowflake auto-manages |
| Graph data updates | Manual OSM download + rebuild | Native app patches |
| Monitoring & alerting | CloudWatch setup required | Built-in Snowflake monitoring |
| Resume on failure | Custom checkpoint logic | Built-in (SEQ_ID tracking) |
| Security & governance | IAM, VPC, encryption setup | Snowflake RBAC + encryption |
| DevOps engineer time | 40-80 hrs @ $150/hr = $6K-$12K | 0 |

**True cost comparison for first run:**

| Approach | Compute | Engineering | Total |
|---|---|---|---|
| Spark on AWS EMR | ~$80 | $6,000 - $12,000 | **$6,080 - $12,080** |
| **ORS on Snowflake** | **$396** | **$0 (native app)** | **$396** |

Spark raw compute is cheaper ($80 vs $396), but the engineering overhead to build, deploy, and maintain the ORS + Spark pipeline makes it **15-30× more expensive** in practice.

### Summary: Cost Per Billion Pairs

| Approach | Cost / Billion Pairs | Time | Engineering Effort |
|---|---|---|---|
| Google Maps API | ~$5,000,000 | Months | Low (but rate-limited) |
| Mapbox / HERE / TomTom | $1,000,000 - $10,000,000 | Months | Low (but rate-limited) |
| Self-hosted ORS + Spark (AWS) | ~$40 compute + $3K-$6K eng | ~6.5 hrs | High (infra + code) |
| **ORS Native App + Snowflake** | **~$204** | **~6.5 hrs** | **Low (managed)** |

### Why This Matters for Delivery/Logistics

For a delivery platform like SwiftBite operating across California:

1. **Pre-computed travel times enable sub-second route optimization** — no API calls at order time
2. **One-time $396 investment** replaces what would cost $9.7M+ via Google Maps
3. **Data stays in Snowflake** — joins directly with order tables, restaurant locations, courier data
4. **Refreshable** — re-run the DAG weekly/monthly as road networks change, same cost
5. **Multi-resolution strategy** — RES7 for strategic planning, RES8 for zone assignment, RES9 for last-mile dispatch

## Comparison: Build vs Query

| Approach | Cost | Latency |
|---|---|---|
| Pre-compute all pairs (this approach) | ~132 credits one-time | Sub-second lookups forever |
| Real-time ORS calls per query | ~0.001 credits/call | 200-500ms per origin |

**Break-even**: If you query more than ~132,000 origin-destination lookups, pre-computing is cheaper. For a delivery dashboard serving multiple users, pre-compute pays for itself almost immediately.

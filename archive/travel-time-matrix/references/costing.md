# Travel Time Matrix — Cost Estimates

## Cost by Region Size

| Region | Example | Resolutions | Origins | Pairs | Credits | Cost ($3/cr) | Time |
|--------|---------|-------------|---------|-------|---------|-------------|------|
| **City** | San Francisco, Dublin | 9 | ~50K | ~6.6M | ~1 | ~$3 | ~5 min |
| **Metro** | Greater LA, London | 8, 9 | ~200K | ~100M | ~8 | ~$24 | ~30 min |
| **State** | California, Bavaria | 7, 8, 9 | ~10M | ~1.94B | ~132 | ~$396 | ~6.5 hrs |
| **Country** | UK, Germany | 6, 7, 8 | ~50M | ~10B | ~680 | ~$2,040 | ~34 hrs |

## Infrastructure Cost Breakdown

### City (3 instances, 3 clusters)

| Resource | Credits/hr | Hours | Credits |
|----------|-----------|-------|---------|
| Warehouse (XSMALL x 3 clusters) | 3 | 0.08 | ~0.25 |
| Compute Pool (3 nodes) | 3 | 0.08 | ~0.25 |
| Flatten Warehouse (XLARGE) | 16 | ~0.03 | ~0.5 |
| **Total** | | **~5 min** | **~1** |

### Metro (5 instances, 5 clusters)

| Resource | Credits/hr | Hours | Credits |
|----------|-----------|-------|---------|
| Warehouse (XSMALL x 5 clusters) | 5 | 0.5 | ~2.5 |
| Compute Pool (5 nodes) | 5 | 0.5 | ~2.5 |
| Flatten Warehouse (XLARGE) | 16 | ~0.05 | ~1 |
| **Total** | | **~30 min** | **~8** |

### State / Reference (10 instances, 10 clusters)

| Resource | Credits/hr | Hours | Credits |
|----------|-----------|-------|---------|
| Warehouse (XSMALL x 10 clusters) | 10 | 6.5 | **65** |
| Compute Pool (10 nodes) | 10 | 6.5 | **65** |
| Flatten Warehouse (XLARGE) | 16 | ~0.1 | **2** |
| **Total** | | **6.5 hrs** | **132** |

### Country (20 instances, 20 clusters)

| Resource | Credits/hr | Hours | Credits |
|----------|-----------|-------|---------|
| Warehouse (XSMALL x 20 clusters) | 20 | 34 | **680** |
| Compute Pool (20 nodes) | 20 | 34 | **680** |
| Flatten Warehouse (XLARGE) | 16 | ~0.15 | **2.4** |
| **Total** | | **~34 hrs** | **~1,362** |

Note: Country-scale runs can reduce cost by using MIN_CLUSTER_COUNT=1 with auto-scaling (saves ~40% vs fixed clusters).

## Cost per Unit

| Metric | City | Metro | State | Country |
|--------|------|-------|-------|---------|
| Cost per million pairs | ~$0.45 | ~$0.24 | ~$0.20 | ~$0.20 |
| Cost per origin | ~$0.00006 | ~$0.00012 | ~$0.00004 | ~$0.00004 |

## By Resolution (single resolution, 10 instances)

| Resolution | Pairs/Origin | Credits/M origins | Wall-clock per M origins |
|------------|-------------|-------------------|------------------------|
| RES 6 (country) | ~1,000 | ~6 | ~15 min |
| RES 7 (state) | ~1,567 | ~7 | ~20 min |
| RES 8 (metro) | ~438 | ~5 | ~15 min |
| RES 9 (city) | ~132 | ~9 | ~25 min |
| RES 10 (hyper-local) | ~60 | ~12 | ~30 min |

## Cost Optimization Tips

1. **Use XSMALL warehouse**: Workers are I/O-bound. XSMALL costs 16x less than MEDIUM with no performance impact.
2. **Auto-suspend aggressively**: FLATTEN_WH at 60s, ROUTING_ANALYTICS at 300s.
3. **Run all resolutions concurrently**: Total wall-clock = slowest resolution, not the sum.
4. **Scale down immediately after**: Credits burn while idle.
5. **Resume-safe workers**: Stop and restart anytime. No wasted work.
6. **Right-size for your region**: A city needs 3 instances. Don't over-provision.
7. **Use MIN_CLUSTER_COUNT=1 with auto-scaling**: Saves ~40-50% vs fixed max clusters for long runs.

## Business Value: Alternative Comparison

| Approach | Cost / Billion Pairs | Time | Engineering Effort |
|----------|---------------------|------|--------------------|
| Google Maps API | ~$5,000,000 | Months | Low (rate-limited) |
| Mapbox / HERE / TomTom | $1M - $10M | Months | Low (rate-limited) |
| Self-hosted ORS + Spark (AWS) | ~$40 compute + $3K-$6K eng | ~6.5 hrs | High |
| **ORS Native App + Snowflake** | **~$204** | **~6.5 hrs** | **Low** |

### Detailed Provider Comparison (1.94B pairs — California reference)

| Provider | Per 1,000 elements | Total Cost |
|----------|-------------------|------------|
| Google Maps | $5.00 - $15.00 | $9.7M - $29.1M |
| Mapbox | $5.00 - $10.00 | $9.7M - $19.4M |
| HERE | $1.00 - $5.00 | $1.9M - $9.7M |
| TomTom | $2.00 - $8.00 | $3.9M - $15.5M |
| **ORS on Snowflake** | **$0.0002** | **$396** |

### Self-Hosted ORS + Spark (AWS EMR)

| Component | Cost/hr | 6.5 hrs |
|-----------|---------|---------|
| EMR Spark cluster (10x r5.2xlarge) | $6.09 | $39.59 |
| ORS instances (10x r5.2xlarge) | $5.04 | $32.76 |
| EBS, S3, data transfer | $1.10 | $7.15 |
| **Compute total** | | **$79.50** |
| DevOps engineering (40-80 hrs) | | **$6,000 - $12,000** |
| **True total** | | **$6,080 - $12,080** |

ORS on Snowflake: **$396** (15-30x cheaper in practice).

## Break-Even: Pre-Compute vs Real-Time

| Approach | Cost | Latency |
|----------|------|---------|
| Pre-compute (this approach) | One-time build cost | Sub-second lookups |
| Real-time ORS calls | ~0.001 credits/call | 200-500ms per origin |

Pre-computing pays for itself after ~132,000 lookups (state-scale). For a city-scale build (~1 credit), it pays for itself after ~1,000 lookups.

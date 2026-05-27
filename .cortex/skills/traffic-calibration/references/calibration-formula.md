# Traffic Calibration — formula and design notes

## The signal

For every trip in `FACT_TRIPS` we observe two travel times:

- `OBSERVED_DURATION_SEC` — wall-clock duration measured from telemetry (last ping timestamp minus first ping timestamp on the trip).
- `ORS_PREDICTED_DURATION_SEC` — the ORS engine's prediction at the trip start, ignoring traffic. ORS routes against the static graph built from OpenStreetMap.

We define the per-trip ratio:

```
ratio = OBSERVED_DURATION_SEC / ORS_PREDICTED_DURATION_SEC
```

A `ratio = 1` means ORS got the trip exactly right. `ratio > 1` means the trip took longer than ORS predicted (congestion, slower-than-modeled traffic-light cycle, etc.). `ratio < 1` means the trip was faster than ORS predicted (low traffic, aggressive driver behaviour).

## Buckets

We aggregate ratios into buckets keyed by:

| Dimension | Reason |
|---|---|
| `PROFILE` | An HGV's `ratio` distribution is very different from `driving-car`. |
| `REGION` | A region-specific graph captures local geometry but not local driving style. |
| `HOUR_OF_DAY` | Captures rush-hour congestion. The single biggest perf knob. |
| `ROAD_CLASS` | Highways congest differently from arterials. |

`DOW` (day of week) is omitted from v1 because it doubles the bucket count and the eval notebook will tell us whether the residual MAPE justifies adding it.

## Aggregation choice

The published factor per bucket is the **median** of the `ratio` distribution, not the mean. GPS errors and one-off events (closed roads, accidents) produce long-tail outliers that drag the mean far from the typical experience. We additionally clip ratios to `[0.3, 3.0]` before aggregating to drop GPS-error blowouts (an order-of-magnitude difference is almost always a measurement artefact, not real traffic).

## Minimum sample size

`HAVING COUNT(*) >= 30` per bucket. With ~14 days of telemetry at typical demo volumes, every (profile, hour, road_class) tuple should clear this threshold for the urban core. Quiet suburban arterials at 3 am may not — those buckets simply fall back to `factor = 1.0` via the `CALIBRATED_DURATION` UDF's COALESCE.

## Eval rubric

The notebook in `assets/` runs the following check:

```python
baseline_mape   = mean(|raw_ors_dur     - observed| / observed)
calibrated_mape = mean(|calibrated_dur  - observed| / observed)
reduction_pct   = 100 * (baseline_mape - calibrated_mape) / baseline_mape
assert reduction_pct >= 10
```

10% relative MAPE reduction is the floor. Realistic demos with enough telemetry land in the 15-25% range on the urban core. If the reduction is below 10%, the next knob to try is adding `DOW` to the bucket key.

## Why we don't write back to the ORS graph

ORS supports custom speed factors via the `weightings` config knob, but those factors are baked into the graph at build time. Re-baking a continental graph for every traffic update is prohibitively expensive (3-day rebuild). Calibrating in Snowflake — i.e. running ORS unchanged and post-multiplying the duration — gives us a hot-swappable calibration with no graph rebuild and zero impact on existing demos.

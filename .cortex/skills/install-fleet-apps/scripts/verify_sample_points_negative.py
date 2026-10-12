#!/usr/bin/env python3
"""Negative tests for fleet_tools/user/verify_sample_points.mts - each case
re-opens one of the paths that let the Function Tester emit a cross-landmass
coordinate pair (or an out-of-band pair with no, or a misleading, hint)."""
import pathlib
import sys

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
from negtest import Harness  # noqa: E402

USER = ".cortex/skills/install-fleet-apps/fleet_tools/user"
MOD = ".cortex/skills/install-fleet-apps/fleet_admin_app/ui/src/components/function-tester/samplePoints.ts"

h = Harness("verify_sample_points.mts", path=f"{USER}/verify_sample_points.mts", cwd=USER,
            cmd=["npx", "tsx"])

# The historical defect: the nearest-neighbour fallback had NO distance ceiling,
# so the nearest pool point to one on Maui was in Boise.
h.replace(MOD, ".filter(x => x.d > 0.01 && x.d <= maxKm * FALLBACK_MAX_MULTIPLE)",
          ".filter(x => x.d > 0.01)",
          expect=": pair within fallback ceiling - separation",
          name="fallback ceiling removed (nearest point at any distance)")

# The edge clamp is a FRACTION of the bbox: applied unconditionally it moves an
# island anchor's offset ~100+ km, a pair no router can serve.
h.replace(MOD, "    if (haversineKm(anchor, [clampedLon, clampedLat]) <= maxKm) {\n",
          "    if (true) {\n",
          expect=": pair within fallback ceiling - separation",
          name="bbox edge clamp applied regardless of the distance band")

# The relaxed final attempt must be CHECKED; an unchecked one still emits a
# hint, but one that blames the region's size (the misleading cause).
h.replace(MOD, "hint: ok ? 'Region is small - using reduced sample distances.' : SPARSE_POOL_HINT",
          "hint: 'Region is small - using reduced sample distances.'",
          expect=": hint names pool sparsity",
          name="relaxed final attempt unchecked (hint blames region size)")

# Worse: the out-of-band pair returned with no hint at all.
h.replace(MOD, "  return { points: pts, hint: ok ? 'Region is small - using reduced sample distances.' : SPARSE_POOL_HINT };",
          "  return { points: pts };",
          expect=": violation is reported - worst pair",
          name="out-of-band pair returned silently")

# Requested cardinality is part of the contract: no silent 2-point MATRIX.
h.replace(MOD, "for (let i = 1; i < count; i++) {", "for (let i = 1; i < Math.min(count, 2); i++) {",
          count=2, expect=": returns 3 points - got 2",
          name="multi-point sample truncated to a pair")

sys.exit(h.finish())

#!/usr/bin/env python3
"""Negative tests for check_studio_generation_guards.py - one mutation per rule
(A-G), each re-introducing the defect the rule pins, plus the comment-left-behind
shape that the gate's comment stripping exists to convict.

Two cases target holes found while writing this file:
  * "callback removed": each jobs.ts call site is followed by a one-shot
    `broadcast(job, 'progress', ...)` AFTER the insert. Rule F used to cut the
    call window at the first `});`, which is the end of that post-insert
    broadcast, so dropping the per-batch callback entirely still PASSED - the
    exact 929 s silence, certified as covered.
  * "declaration removed": rule C's own diagnostic was unreachable because its
    inspected-count is the same regex as its check, so the vacuity branch
    returned first and printed only "the paths in this gate are stale"."""
import pathlib
import sys

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
from negtest import Harness  # noqa: E402

STUDIO = ".cortex/skills/install-fleet-apps/fleet_admin_app/ui/src/server/studio"
ROUT = f"{STUDIO}/engine/routability.ts"
PROF = f"{STUDIO}/profiles.ts"
INS = f"{STUDIO}/inserters.ts"
JOBS = f"{STUDIO}/jobs.ts"
CAP = "const poiCap = config.poi_cap ?? poiCapDefault;"

h = Harness("check_studio_generation_guards.py")

# A - the override is no longer read
h.replace(ROUT, CAP, "const poiCap = poiCapDefault;",
          expect="A: the POI cap is not resolved as `config.poi_cap ?? <default>`",
          name="A: preset poi_cap override dropped")
h.replace(ROUT, CAP, "// was: const poiCap = config.poi_cap ?? poiCapDefault;\n"
          "  const poiCap = poiCapDefault;",
          expect="A: the POI cap is not resolved as",
          name="A: override dropped, explanatory comment left (comment stripping)")
# B - `||` turns an explicit 0 back into the default
h.replace(ROUT, CAP, "const poiCap = config.poi_cap || poiCapDefault;",
          expect="B: POI cap resolved with `||`",
          name="B: ?? reverted to ||")
# C - the field is no longer declared on GenerationConfig
h.replace(PROF, "  poi_cap?: number | null;\n", "",
          expect="C: `poi_cap` is not declared on GenerationConfig",
          name="C: poi_cap declaration removed")
# D - a setup-phase inserter no longer accepts a beat
h.replace(INS,
          "insertDimPartners(partners: any[], config: GenerationConfig, snowSql: SnowSqlFn, "
          "jobId: string, onProgress?: (inserted: number, total: number) => void)",
          "insertDimPartners(partners: any[], config: GenerationConfig, snowSql: SnowSqlFn, "
          "jobId: string)",
          expect="D: `insertDimPartners` runs in the SETUP phase",
          name="D: setup inserter takes no onProgress")
# E - the beat fires once after the loop instead of per batch
h.replace(INS,
          "    beat(Math.min(i + batchSize, pois.length));\n  }\n}",
          "  }\n  beat(pois.length);\n}",
          expect="E: `insertDimPois` accepts onProgress but never invokes it INSIDE",
          name="E: beat moved after the batch loop")
# E - declared but never called (first `beat(inserted);` is insertFactOffers)
h.replace(INS, "    beat(inserted);\n", "",
          expect="E: `insertFactOffers` accepts onProgress but never invokes it INSIDE",
          name="E: beat parameter declared but never invoked")
# F - the call site broadcasts the wrong event kind
h.replace(JOBS,
          "broadcast(job, 'progress', { status: `Inserted ${done}/${total} partners` });",
          "broadcast(job, 'warning', { message: `Inserted ${done}/${total} partners` });",
          expect="F: the `insertDimPartners` call site does not pass a callback",
          name="F: callback broadcasts a non-progress event")
# F - the callback is gone; only the one-shot post-insert broadcast remains
h.replace(JOBS,
          "await insertDimPois(pois, config, snowSql, jobId, (done, total) => {\n"
          "          broadcast(job, 'progress', { status: `Inserted ${done}/${total} POIs` });\n"
          "        });",
          "await insertDimPois(pois, config, snowSql, jobId);",
          expect="F: the `insertDimPois` call site does not pass a callback",
          name="F: per-batch callback removed (post-insert broadcast must not count)")
# G - cadence too coarse to beat inside the 15 min watchdog window
h.replace(INS, "const PROGRESS_ROWS = 10_000;", "const PROGRESS_ROWS = 1_000_000;",
          expect="G: PROGRESS_ROWS=1000000 is too coarse",
          name="G: cadence threshold beyond the watchdog window")
h.replace(INS, "function makeProgressBeat(", "function makeBeat(",
          expect="G: makeProgressBeat helper not found",
          name="G: shared cadence helper removed")
sys.exit(h.finish())

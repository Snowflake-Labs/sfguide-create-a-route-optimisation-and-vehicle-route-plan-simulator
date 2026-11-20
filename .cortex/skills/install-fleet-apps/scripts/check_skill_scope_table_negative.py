#!/usr/bin/env python3
"""Negative tests for check_skill_scope_table.py - each case re-creates a way the
install-fleet-apps SKILL.md scope lists could again disagree with what installs.

M1 is the original defect: an EXCLUDED list naming Backload Matching while the
SA app ships it."""
import pathlib
import sys

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
from negtest import Harness  # noqa: E402

SKILL = ".cortex/skills/install-fleet-apps/SKILL.md"
PACK = ".cortex/skills/install-fleet-apps/fleet_sa_app/ui/src/lib/packs/fleet/pack-views.json"
END = "<!-- scope:end -->"

h = Harness("check_skill_scope_table.py")

h.replace(SKILL, END, END + "\n\n| UI views | EXCLUDED: Freight Marketplace, Backload Matching |",
          expect="excluded: Backload Matching",
          name="M1 the original bug: an EXCLUDED list names an installed view")

h.replace(SKILL, "Backload Proposals, ", "", expect="Backload Proposals",
          name="M2 a shipped view dropped from the generated list")

h.replace(SKILL, "`SV_BACKLOAD_MATCHING`, ", "", expect="SV_BACKLOAD_MATCHING",
          name="M3 a created semantic view dropped from the list")

h.replace(PACK, '"Ops Console"', '"Ops Console Renamed"', expect="Ops Console Renamed",
          name="M4 a view relabelled in source without regenerating the block")

h.replace(SKILL, END, "", expect="markers missing",
          name="M5 the generated block's end marker deleted")

sys.exit(h.finish())

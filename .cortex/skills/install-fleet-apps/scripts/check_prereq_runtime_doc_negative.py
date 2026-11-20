#!/usr/bin/env python3
"""Negative tests for check_prereq_runtime_doc.py - each case re-creates a way
the routing-prerequisites skill could again disagree with the installer's
health-based container-runtime choice.

M1 is the original defect: the skill says Docker is required."""
import pathlib
import sys

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
from negtest import Harness  # noqa: E402

SKILL = ".cortex/skills/routing-prerequisites/SKILL.md"
NOTE = "**Note:** one usable runtime, Docker or Podman, is required."

h = Harness("check_prereq_runtime_doc.py")

h.replace(SKILL, NOTE, "**Note:** Docker is required.", expect="claims Docker is mandatory",
          name="M1 the original bug: the skill says Docker is required")

h.replace(SKILL, "**Podman**:", "**Podman** (optional, engine image build only):",
          expect="claims Docker is mandatory",
          name="M2 Podman demoted to the engine build only")

h.replace(SKILL, "&& resolve_container_runtime --no-start \\",
          "&& true \\", expect="does not run the installer's probe",
          name="M3 the probe call removed from the step-1 check")

h.replace(SKILL, "   | Container runtime (Docker or Podman, usable per the probe) | \u2705/\u274c | Yes |",
          "   | Docker (CLI + running daemon) | \u2705/\u274c | Yes |",
          expect="claims Docker is mandatory",
          name="M4 summary table row reverted to Docker-only")

sys.exit(h.finish())

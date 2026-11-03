#!/usr/bin/env python3
"""The routing-prerequisites skill must check the container runtime the way the
installer picks it.

A fresh-clone install found the skill telling users Docker was required and
Podman "alone is NOT sufficient", while scripts/lib/container_runtime.sh had
already made the installer, the engine build and both app deploys accept a
healthy Podman. A new user without Docker would install it for nothing; one
with a signed-out Docker Desktop would pass the skill's `docker info` check and
then fail the build. The skill must therefore (1) call the installer's own
`resolve_container_runtime` probe and (2) not claim Docker is mandatory while
the probe has a podman branch."""
import pathlib
import re
import sys

REPO = pathlib.Path(__file__).resolve().parents[4]
SKILL = REPO / ".cortex/skills/routing-prerequisites/SKILL.md"
LIB = REPO / ".cortex/skills/install-fleet-apps/scripts/lib/container_runtime.sh"
PROBE = "install-fleet-apps/scripts/lib/container_runtime.sh"
DOCKER_ONLY = [
    r"Docker is required",
    r"Docker \(required\)",
    r"Podman alone is NOT sufficient",
    r"Podman[^\n|]{0,40}engine (image )?build only",
    r"\(Docker required, Podman optional\)",
    r"Docker \(CLI \+ running daemon\)\s*\|[^\n]*\|\s*Yes",
]


def main() -> int:
    text, lib = SKILL.read_text(), LIB.read_text()
    errs = []
    # The probe must be in Step 1 (the check the user runs), not just the
    # Verification block further down.
    step1 = text.split("### Step 1", 1)[-1].split("### Step 2", 1)[0]
    if not re.search(PROBE.replace(".", r"\.") + r"[^\n]*\n?[^\n]*resolve_container_runtime", step1):
        errs.append("does not run the installer's probe in Step 1 (source "
                    f"{PROBE} && resolve_container_runtime)")
    if "podman" in lib:
        for pat in DOCKER_ONLY:
            m = re.search(pat, text, re.I)
            if m:
                errs.append(f"claims Docker is mandatory ({m.group(0)!r}) but "
                            "container_runtime.sh accepts a healthy podman")
    for e in errs:
        print(f"FAIL routing-prerequisites/SKILL.md {e}")
    if not errs:
        print("ok  routing-prerequisites runs the installer's runtime probe and allows Docker or Podman")
    return 1 if errs else 0


if __name__ == "__main__":
    sys.exit(main())

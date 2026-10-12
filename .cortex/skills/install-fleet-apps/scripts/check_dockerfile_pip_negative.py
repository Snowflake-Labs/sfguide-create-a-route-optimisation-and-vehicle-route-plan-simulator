#!/usr/bin/env python3
"""Negative tests for check_dockerfile_pip.py - each case re-creates a way an
image build could again print pip's root-user WARNING into the install log, and
the gate must name the file and stage.

M1 is the original defect: the gateway Dockerfile with no PIP_ROOT_USER_ACTION."""
import pathlib
import sys

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
from negtest import Harness  # noqa: E402

SVC = ".cortex/skills/install-fleet-apps/openrouteservice_app/services"
GW = f"{SVC}/gateway/Dockerfile"
DL = f"{SVC}/downloader/Dockerfile"
ENV = "ENV PIP_ROOT_USER_ACTION=ignore\n"

h = Harness("check_dockerfile_pip.py")
_saved: dict[str, str] = {}

h.replace(GW, ENV, "", expect="gateway/Dockerfile stage 1",
          name="M1 the original bug: gateway image runs pip as root with no ENV")

h.replace(DL, ENV + "RUN pip install --upgrade pip && \\\npip install flask requests",
          "RUN pip install --upgrade pip && \\\npip install flask requests\n" + ENV,
          expect="downloader/Dockerfile stage 1",
          name="M2 ENV declared only AFTER the pip RUN")

h.replace(GW, ENV, "# " + ENV, expect="gateway/Dockerfile stage 1",
          name="M3 ENV commented out still reads as present")

h.replace(GW, ENV, "ENV PIP_ROOT_USER_ACTION=warn\n", expect="gateway/Dockerfile stage 1",
          name="M4 ENV set to a value that still warns")


def env_in_earlier_stage_only() -> None:
    p = h.path(GW)
    text = _saved.setdefault(GW, p.read_text())
    p.write_text(text.replace(ENV, "").replace(
        "FROM $BASE_IMAGE\n", "FROM $BASE_IMAGE AS deps\n" + ENV + "FROM $BASE_IMAGE\n", 1))


def restore_gw() -> None:
    h.path(GW).write_text(_saved[GW])


h.custom("M5 ENV only in an earlier stage does not carry past FROM", env_in_earlier_stage_only,
         restore_gw, expect="gateway/Dockerfile stage 2")


def flag_one_call_only() -> None:
    p = h.path(DL)
    text = _saved.setdefault(DL, p.read_text())
    p.write_text(text.replace(ENV, "").replace(
        "RUN pip install --upgrade pip", "RUN pip install --root-user-action=ignore --upgrade pip"))


def restore_dl() -> None:
    h.path(DL).write_text(_saved[DL])


h.custom("M6 --root-user-action on ONE of two pip calls, ENV removed", flag_one_call_only,
         restore_dl, expect="downloader/Dockerfile stage 1")

h.add(f"{SVC}/newsvc/Dockerfile", "FROM python:3.10-slim\nRUN python3 -m pip install flask\n",
      expect="newsvc/Dockerfile stage 1", name="M7 a new image added without the ENV")

sys.exit(h.finish())

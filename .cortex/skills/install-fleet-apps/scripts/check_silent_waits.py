#!/usr/bin/env python3
"""Gate: the installer never collects a background job with a bare `wait`.

WHAT WENT WRONG. Step 3 collected the engine image phase (forked at step 1.5)
with `wait "$ENGINE_IMAGES_PID"`. On a fresh account that push takes ~30 min,
and the main log printed one "collecting..." line and then nothing, so a
customer could not tell a slow push from a hang.

RULE A - outside wait_with_progress, no `wait` on a backgrounded *_PID.
RULE B - wait_with_progress polls the job (`kill -0`), sleeps, and prints a
         progress `note` INSIDE that loop (a note after the loop is silent).
"""
import pathlib
import re
import sys

SCRIPTS = pathlib.Path(__file__).resolve().parent
FILES = ["install_fleet_apps.sh"]
BARE_WAIT = re.compile(r'\bwait\s+"?\$\{?[A-Z_]*_PID\b')


def strip_comments(text: str) -> str:
    return "\n".join(re.sub(r"(^|\s)#.*$", "", ln) for ln in text.splitlines())


def helper_body(text: str) -> tuple[str, int, int]:
    m = re.search(r"^wait_with_progress\(\)\s*\{\n(.*?)^\}", text, re.S | re.M)
    if not m:
        return "", -1, -1
    return m.group(1), m.start(), m.end()


def main() -> int:
    errors = []
    for name in FILES:
        text = strip_comments((SCRIPTS / name).read_text())
        body, s, e = helper_body(text)
        if s < 0:
            errors.append(f"{name}: wait_with_progress() is not defined")
        outside = text[:s] + text[e:] if s >= 0 else text
        for i, ln in enumerate(outside.splitlines(), 1):
            if BARE_WAIT.search(ln):
                errors.append(f"{name}: RULE A bare wait on a background job: {ln.strip()}")
        if s >= 0:
            loop = re.search(r"while\s+kill\s+-0\b(.*?)\bdone\b", body, re.S)
            if not loop:
                errors.append(f"{name}: RULE B wait_with_progress has no `while kill -0` poll loop")
            else:
                if not re.search(r"\bsleep\b", loop.group(1)):
                    errors.append(f"{name}: RULE B poll loop never sleeps")
                if not re.search(r"\bnote\b", loop.group(1)):
                    errors.append(f"{name}: RULE B poll loop prints no progress note")
    for e in errors:
        print("FAIL", e)
    if errors:
        return 1
    print("PASSED: background jobs are collected with a progress heartbeat.")
    return 0


if __name__ == "__main__":
    sys.exit(main())

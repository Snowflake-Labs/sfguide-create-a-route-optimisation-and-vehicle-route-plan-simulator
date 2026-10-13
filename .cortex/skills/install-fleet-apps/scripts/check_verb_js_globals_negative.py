#!/usr/bin/env python3
"""Negative tests for check_verb_js_globals.py - each case puts a host-only
JavaScript global (absent from the LANGUAGE JAVASCRIPT proc runtime) into code
esbuild bundles into a verb, and the gate must name the global.

The first two cases are the shipped deep_link defect in both shapes it can take:
the query string built in a statement, and built inline in the returned URL's
template literal."""
import pathlib
import sys

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
from negtest import Harness  # noqa: E402

TOOLS = ".cortex/skills/install-fleet-apps/fleet_tools"
DEEP_LINK = f"{TOOLS}/user/src/procs/deep_link.ts"
PARTS = "    const parts: string[] = [`view=${encodeURIComponent(viewId)}`];\n"
URL_LINE = "      url: `https://${host}/?${parts.join('&')}`,\n"

h = Harness("check_verb_js_globals.py")

h.replace(DEEP_LINK, PARTS,
          "    const qs = new URLSearchParams({ view: viewId });\n" + PARTS,
          expect="URLSearchParams is not available", name="deep_link builds its query with URLSearchParams")
h.replace(DEEP_LINK, URL_LINE,
          "      url: `https://${host}/?${new URLSearchParams({ view: viewId }).toString()}`,\n",
          expect="URLSearchParams is not available",
          name="URLSearchParams inside a template-literal interpolation")
h.replace(DEEP_LINK, URL_LINE, "      url: new URL(`/?${parts.join('&')}`, `https://${host}`).toString(),\n",
          expect="URL is not available", name="URL constructor in a verb")
h.add(f"{TOOLS}/ops/src/negtest_encode.ts",
      "export function toB64(s: string): string {\n  return Buffer.from(s).toString('base64');\n}\n",
      expect="Buffer is not available", name="Buffer in an ops helper")
h.add(f"{TOOLS}/admin/src/negtest_env.ts",
      "export const defaultRegion = (): string => process.env.DEFAULT_REGION ?? '';\n",
      expect="process is not available", name="process.env in an admin helper")
h.add(f"{TOOLS}/vendor/synapse/src/runtime/negtest_http.ts",
      "export async function ping(): Promise<number> {\n  return (await fetch('https://example.invalid')).status;\n}\n",
      expect="fetch is not available", name="fetch in the bundled synapse runtime")
h.add(f"{TOOLS}/user/src/negtest_timer.mts",
      "export const later = (f: () => void): void => { setTimeout(f, 10); };\n",
      expect="setTimeout is not available", name="timer in a .mts source")

root = h.path(TOOLS)
moved = h.path(".cortex/skills/install-fleet-apps/fleet_tools_moved")
h.custom("every scan root moved away (vacuity)", lambda: root.rename(moved), lambda: moved.rename(root),
         expect="found nothing to scan")

sys.exit(h.finish())

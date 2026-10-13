#!/usr/bin/env python3
"""Negative tests for check_client_polling.py, which is DEFAULT-DENY: any raw
setInterval in a browser-side tree is a finding unless the file declares the
timer UI-only WITH a reason.

The first case is the shape that motivated default-deny: the six loops that lost
the visibility guard all ticked an INDIRECT helper, never a literal fetch, so a
body-level fetch check would have passed every one. The last case abuses the
opt-out: a marker with no reason must not count. It used to, because the
marker regex let `\\s*` after `--` cross the newline and take the next CODE
line (`useEffect(() => {`) as the reason."""
import pathlib
import sys

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
from negtest import Harness  # noqa: E402

SKILL = ".cortex/skills/install-fleet-apps"
ADMIN = f"{SKILL}/fleet_admin_app/ui/src"
SA = f"{SKILL}/fleet_sa_app/ui/src"
JOBS_HOOK = f"{ADMIN}/components/region-builder/hooks/useProvisionJobs.ts"
BADGE = f"{SA}/components/views/areas/freshness-badge.tsx"

h = Harness("check_client_polling.py")

h.replace(JOBS_HOOK,
          "useVisiblePolling(fetchProvisionJobs, JOB_POLL_MS, hasActiveJobs);",
          "useEffect(() => { const t = setInterval(fetchProvisionJobs, JOB_POLL_MS); "
          "return () => clearInterval(t); }, []);",
          expect="region-builder/hooks/useProvisionJobs.ts:",
          name="raw setInterval ticking an indirect helper (no fetch in the body)")
h.add(f"{SA}/components/negtest-poller.tsx",
      "import { useEffect } from 'react';\n"
      "export function NegtestPoller() {\n"
      "  useEffect(() => {\n"
      "    const t = setInterval(() => { fetch('/api/query'); }, 5000);\n"
      "    return () => clearInterval(t);\n"
      "  }, []);\n"
      "  return null;\n"
      "}\n",
      expect="components/negtest-poller.tsx:4: raw setInterval",
      name="raw setInterval with a literal fetch in an SA component")
h.add(f"{SA}/hooks/useNegtestPoll.ts",
      "export function useNegtestPoll(cb: () => void) {\n"
      "  const id = window.setInterval(cb, 3000);\n"
      "  return () => window.clearInterval(id);\n"
      "}\n",
      expect="hooks/useNegtestPoll.ts:2: raw setInterval",
      name="window.setInterval in an SA hook")
h.replace(BADGE,
          "  // polling-gate: ui-only -- re-renders a relative timestamp ('3m ago') from a\n"
          "  // prop; fetches nothing. The data behind it is refreshed elsewhere.\n",
          "  // polling-gate: ui-only --\n",
          expect="freshness-badge.tsx:",
          name="opt-out marker abused without a reason")
sys.exit(h.finish())

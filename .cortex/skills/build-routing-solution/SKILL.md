---
name: build-routing-solution
description: "DEPRECATED / RETIRED. The ORS/VROOM routing engine build was absorbed into install-fleet-apps (Phase C). Use when: build routing solution, set up OpenRouteService, build and push SPCS images, deploy ORS app, redeploy app, rebuild container images, provision the routing engine. This skill now only redirects to install-fleet-apps (which builds the engine by default). Do NOT use for: anything directly - follow install-fleet-apps. Triggers: build routing solution, install openrouteservice app, set up OpenRouteService, build and push SPCS images, deploy ORS app, rebuild images, SPCS image build, OpenRouteService deployment, provision routing engine."
metadata:
  author: Snowflake SIT-IS
  version: 2.0.0
  category: infrastructure
---

# build-routing-solution - RETIRED (see install-fleet-apps)

This skill has been **retired**. The ORS/VROOM routing-engine build substrate
(SQL modules, the 4 engine service images, staged map/config, build scripts, and
the image tags) was absorbed into **`install-fleet-apps`** in Phase C. The engine
keeps the `OPENROUTESERVICE_APP.CORE` runtime namespace behind the
`ROUTING_PLATFORM.CONTRACT` seam.

## What to do instead

Build + provision the live engine natively with the primary installer (the engine is built by default):

```bash
bash .cortex/skills/install-fleet-apps/scripts/install_fleet_apps.sh \
  --connection <connection>
```

- Engine build/provision details: `.cortex/skills/install-fleet-apps/references/routing-engine.md`
- Image build: `.cortex/skills/install-fleet-apps/references/build-images.md`
- Functions / limits / matrix: `.cortex/skills/install-fleet-apps/references/available-functions.md`
- SQL scripting + gotchas: `.cortex/skills/install-fleet-apps/references/snowflake-scripting-guidelines.md`, `.cortex/skills/install-fleet-apps/references/snowflake-sql-gotchas.md`
- Troubleshooting: `.cortex/skills/install-fleet-apps/references/troubleshooting.md`

The remaining files under this folder (`openrouteservice_app/services/ors_control_app/`,
`native_app/`, `scripts/deploy.sh`) are the legacy Vite control app, superseded by
`fleet_admin_app`. They are kept only until a clean-account engine
end-to-end run confirms parity, after which this folder will be deleted entirely.

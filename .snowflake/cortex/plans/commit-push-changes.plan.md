# Plan: Commit and Push Latest Changes

## Current State

- Branch: `coco-direct` (up to date with `origin/coco-direct`)
- Remote: `ssh://git@github.com/Snowflake-Labs/sfguide-create-a-route-optimisation-and-vehicle-route-plan-simulator.git`
- 13 modified files, 476 insertions, 115 deletions

## Files to Commit

### App Code (9 files)
- [`build-routing-solution/Native_app/app/setup_script.sql`](build-routing-solution/Native_app/app/setup_script.sql) — WRITE_ORS_CONFIG procedure, DROP+CREATE control app, EAI host fixes
- [`build-routing-solution/Native_app/app/manifest.yml`](build-routing-solution/Native_app/app/manifest.yml) — v1.0.5 image tag, CARTO EAI reference
- [`build-routing-solution/Native_app/services/ors_control_app/ors_control_app_service.yaml`](build-routing-solution/Native_app/services/ors_control_app/ors_control_app_service.yaml) — v1.0.5 image tag
- [`build-routing-solution/Native_app/services/ors_control_app/src/components/CityProvisioner.tsx`](build-routing-solution/Native_app/services/ors_control_app/src/components/CityProvisioner.tsx) — routing profile checkboxes
- [`build-routing-solution/Native_app/services/ors_control_app/src/components/FunctionTester.tsx`](build-routing-solution/Native_app/services/ors_control_app/src/components/FunctionTester.tsx) — dynamic profile loading
- [`build-routing-solution/Native_app/services/ors_control_app/server/index.ts`](build-routing-solution/Native_app/services/ors_control_app/server/index.ts) — WRITE_ORS_CONFIG call in provision endpoint
- [`build-routing-solution/Native_app/services/ors_control_app/index.html`](build-routing-solution/Native_app/services/ors_control_app/index.html) — profile selector CSS
- [`build-routing-solution/Native_app/services/ors_control_app/package.json`](build-routing-solution/Native_app/services/ors_control_app/package.json) — dependency updates
- [`build-routing-solution/Native_app/services/ors_control_app/dist-server/index.js`](build-routing-solution/Native_app/services/ors_control_app/dist-server/index.js) — compiled server bundle

### Skill Documentation (4 files)
- [`.cortex/skills/build-routing-solution/SKILL.md`](.cortex/skills/build-routing-solution/SKILL.md) — v1.0.5 tag, CARTO EAI docs, basemap troubleshooting
- [`.cortex/skills/routing-customization/SKILL.md`](.cortex/skills/routing-customization/SKILL.md) — updated Function Tester note (dynamic profiles)
- [`.cortex/skills/routing-customization/location/SKILL.md`](.cortex/skills/routing-customization/location/SKILL.md) — :443 port suffixes, WRITE_ORS_CONFIG option
- [`.cortex/skills/routing-customization/routing-profiles/SKILL.md`](.cortex/skills/routing-customization/routing-profiles/SKILL.md) — v1.1.0 rewrite with WRITE_ORS_CONFIG

## Steps

1. **Stage all files:** `git add -A`
2. **Commit** with message summarizing the changes
3. **Push** to `origin coco-direct`

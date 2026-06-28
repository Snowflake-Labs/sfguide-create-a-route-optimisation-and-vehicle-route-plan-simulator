# @fleet-kit/core - Shared UI kit

The single home for the **framework-agnostic** UI and data primitives shared by the two
frontends of this repo:

- **Analytics App** (consumer + ops surfaces) - `.cortex/skills/install-fleet-apps/fleet_sa_app/ui` (Next.js)
- **Routing Platform admin/build console** - `.cortex/skills/build-routing-solution/openrouteservice_app/services/ors_control_app` (being modernized onto Next in R5)

## Why this exists

Today the two apps duplicate the same primitives (deck.gl map DSL, the Snowflake REST
client, SPCS OAuth/PAT auth, the SQL JSON-literal helper, chart/metric primitives). This
package is the deduplicated source of truth so a fix lands once and both apps consume it.

This is part of the "**2 products / 3 surfaces / 1 UI kit**" restructuring. See the phased
plan at `../../.cortex/skills/install-fleet-apps/fleet_sa_app/APP_RESTRUCTURE_PLAN.md`.

## Status

**R0 (current): empty shell, not yet imported.** Standing it up here changes no app build.

**R1 (next): populate + repoint.** The portable modules below get relocated here and the
consumer app repointed to import them via a relative `file:` dependency (mirroring the
existing `fleet_tools/vendor/synapse` vendoring pattern). The built `dist/` is committed
and shipped (node_modules stays git-ignored) so a fresh install needs only public npm.

## Planned subpath layout (R1)

| Subpath | Contents | Extracted from |
|---|---|---|
| `@fleet-kit/core/map` | `layer-spec`, `layer-compiler`, `map-fit` | `ui/src/lib/map/*` (+ control-app `src/dynamic/layer-compiler.ts`, `src/shared/mapFit.ts`) |
| `@fleet-kit/core/sf-client` | REST `/api/v2/statements` client core (async poll + type coercion) | `ui/src/lib/snowflake.ts` (+ control-app `server/lib/sql.ts`) |
| `@fleet-kit/core/sf-auth` | SPCS OAuth (`/snowflake/session/token`) + local PAT dual-mode | `ui/src/lib/sf-auth.ts` (+ control-app `server/lib/sanitize.ts:getSpcsToken`) |
| `@fleet-kit/core/sql-utils` | `asSqlJsonLiteral` (dollar-quoted JSON) + identifier sanitizers | control-app `src/lib/sfQuery.ts` |
| `@fleet-kit/core/types` | shared view/area/layer types | `ui/src/lib/types.ts`, `ui/src/lib/map/layer-spec.ts` |

React-coupled area components (`view-renderer`, charts) move in a later R1 step; only the
framework-agnostic core lands first so the consumer build stays green throughout.

## Build

```bash
cd packages/fleet-kit
npm install        # dev: typescript only
npm run build      # emits dist/ (committed)
```

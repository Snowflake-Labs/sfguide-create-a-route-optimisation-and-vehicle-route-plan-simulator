// @fleet-kit/core — shared, framework-agnostic UI/data primitives.
//
// EMPTY SHELL (R0 of APP_RESTRUCTURE_PLAN). This package is intentionally not yet
// imported by either app. R1 populates the subpath modules below by relocating the
// portable primitives that today live duplicated across the two frontends:
//
//   ./map        layer-spec, layer-compiler, map-fit  (deck.gl DSL)
//   ./sf-client  REST /api/v2/statements client core (poll + type-coerce)
//   ./sf-auth    SPCS OAuth (/snowflake/session/token) + local PAT dual-mode auth
//   ./sql-utils  asSqlJsonLiteral (dollar-quoted JSON) + identifier sanitizers
//   ./types      shared view/area/layer types
//
// See .cortex/skills/build-routing-solution/fleet_sa_app/APP_RESTRUCTURE_PLAN.md (R1).

export const FLEET_KIT_VERSION = "0.0.0";

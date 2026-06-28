// @fleet-kit/core - shared, framework-agnostic UI/data primitives.
//
// Populated incrementally per APP_RESTRUCTURE_PLAN R1. Subpath modules (import
// from the subpath, not the root barrel, to keep server-only modules out of
// client bundles):
//
//   @fleet-kit/core/sf-auth    SPCS OAuth (/snowflake/session/token) + local PAT  [server-only; node fs]
//   @fleet-kit/core/sql-utils  asSqlJsonLiteral / safeText / sanitizeIdent        [pure]
//   @fleet-kit/core/map        layer-spec DSL types (deck.gl compiler joins in R1 increment 2)  [types]
//
// See .cortex/skills/install-fleet-apps/fleet_sa_app/APP_RESTRUCTURE_PLAN.md (R1).
export const FLEET_KIT_VERSION = "0.1.0";
//# sourceMappingURL=index.js.map
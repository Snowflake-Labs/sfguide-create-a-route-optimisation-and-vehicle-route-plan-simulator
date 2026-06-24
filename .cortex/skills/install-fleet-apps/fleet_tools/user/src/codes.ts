// App-specific synapse error codes for the routing-tools bundle.
//
// `ctx.fail(code, msg)` accepts any string code, so these compose with the
// framework-canonical Codes (BAD_VALUE_TYPE, WRONG_STATE_FOR_VERB, ...) without
// wrapping. A code thrown from a verb's `validate` (or `execute`) hook is
// preserved by the runtime envelope: it lands in the `verb_attempt.error_code`
// audit column AND propagates to the caller, so the agent gets a typed,
// explainable failure instead of an opaque downstream SQL error.
export const RoutingCodes = {
  /** num_vehicles must be a positive integer. */
  INVALID_VEHICLE_COUNT: 'INVALID_VEHICLE_COUNT',
  /** profile is not one of the supported ORS routing profiles. */
  UNSUPPORTED_PROFILE: 'UNSUPPORTED_PROFILE',
  /** region is not a provisioned (DEPLOYED) routing region. */
  REGION_NOT_PROVISIONED: 'REGION_NOT_PROVISIONED',
} as const;

// Error codes for the Overture Maps query verbs (query_overture_places /
// query_overture_addresses). Mirror the typed error_code values the underlying
// TOOL_OVERTURE_SEARCH / TOOL_OVERTURE_ADDRESSES procs return, so a failure is
// explainable whether it is caught in the verb's validate hook or surfaced by
// the proc.
export const OvertureCodes = {
  /** Neither a resolvable region nor a complete bbox was supplied. */
  MISSING_BOUNDS: 'OVERTURE_MISSING_BOUNDS',
  /** The named region has no boundary in REGION_CATALOG (and no bbox fallback). */
  REGION_NOT_FOUND: 'OVERTURE_REGION_NOT_FOUND',
  /** group_by is not one of the supported aggregation modes. */
  UNSUPPORTED_GROUP_BY: 'OVERTURE_UNSUPPORTED_GROUP_BY',
  /** max_results is not a positive integer. */
  INVALID_MAX_RESULTS: 'OVERTURE_INVALID_MAX_RESULTS',
  /** A bbox was partially supplied (need all of min/max lon/lat or none). */
  INCOMPLETE_BBOX: 'OVERTURE_INCOMPLETE_BBOX',
} as const;

/** Supported group_by modes for query_overture_places. */
export const OVERTURE_PLACES_GROUP_BY = ['list', 'city', 'category'] as const;

/** Supported group_by modes for query_overture_addresses. */
export const OVERTURE_ADDRESSES_GROUP_BY = ['list', 'city'] as const;

/** Supported ORS routing profiles. Used by verb validate hooks. */
export const SUPPORTED_PROFILES = [
  'driving-car',
  'driving-hgv',
  'cycling-regular',
  'foot-walking',
] as const;

// Error codes for the render_view verb (agent-emitted dynamic pages).
export const RenderCodes = {
  /** spec_json did not parse as JSON, or was not a JSON object. */
  INVALID_SPEC_JSON: 'INVALID_SPEC_JSON',
  /** spec is missing layout.default.grid or has no areas. */
  INVALID_SPEC_SHAPE: 'INVALID_SPEC_SHAPE',
  /** an area references a component not in the renderer's allowlist. */
  UNKNOWN_COMPONENT: 'UNKNOWN_COMPONENT',
} as const;

// Renderer area components an agent may emit. MUST stay in sync with
// AREA_COMPONENTS in fleet_sa_app/ui/src/components/views/view-renderer.tsx.
// The client-side zod validator (view-spec-schema.ts) is the authoritative
// gate; this list gives the agent a typed early failure to self-correct.
export const RENDER_COMPONENTS = [
  'MetricCards',
  'Chart',
  'Table',
  'ComboBox',
  'FilterBar',
  'Map',
  'Slider',
  'ClickableTable',
  'Checkbox',
  'EntityDetail',
] as const;

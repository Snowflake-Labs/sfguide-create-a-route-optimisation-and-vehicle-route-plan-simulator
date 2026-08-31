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

/**
 * Supported ORS routing profiles - the graphs the engine actually builds.
 * Used by verb validate hooks AFTER the profile is resolved via resolveProfile().
 * The default region builds driving-car, driving-hgv, and cycling-electric only;
 * cycling-regular / foot-walking are NOT built, so they are mapped to a built
 * profile by resolveProfile() rather than listed here (an unmapped value that is
 * not in this list is rejected with UNSUPPORTED_PROFILE instead of erroring at
 * the engine with an opaque ORS 2003 "profile unknown").
 */
export const SUPPORTED_PROFILES = [
  'driving-car',
  'driving-hgv',
  'cycling-electric',
] as const;

/**
 * Maps a vehicle_type (from DIM_DATASETS / the context bar) OR a loosely-named
 * routing profile to the ORS profile the engine actually builds. The engine
 * builds 'cycling-electric' as its only cycling graph, so every cycling variant
 * and the 'ebike' vehicle_type resolve to it - otherwise a cycle/ebike request
 * either errored (ORS 2003 for the unbuilt cycling-regular) or silently routed
 * as driving-car (wrong travel mode). Mirrors the SQL whitelist in
 * routing-agent/references/deploy-agent.sql and DIM_VEHICLE_PROFILE.
 */
export const VEHICLE_TYPE_TO_PROFILE: Record<string, string> = {
  car: 'driving-car',
  van: 'driving-car',
  'driving-car': 'driving-car',
  hgv: 'driving-hgv',
  truck: 'driving-hgv',
  'driving-hgv': 'driving-hgv',
  ebike: 'cycling-electric',
  'e-bike': 'cycling-electric',
  bike: 'cycling-electric',
  bicycle: 'cycling-electric',
  cycle: 'cycling-electric',
  'cycling-regular': 'cycling-electric',
  'cycling-mountain': 'cycling-electric',
  'cycling-road': 'cycling-electric',
  'cycling-electric': 'cycling-electric',
};

/**
 * Resolve a caller-supplied profile/vehicle string to a built ORS profile.
 * Returns null unchanged (the TOOL_* proc then applies the active-context
 * default). Unknown values are passed through so the verb's validate hook can
 * reject them with a typed UNSUPPORTED_PROFILE rather than masking a typo.
 */
export function resolveProfile(profile: string | null | undefined): string | null {
  if (profile === null || profile === undefined || profile === '') return null;
  const key = String(profile).trim().toLowerCase();
  return VEHICLE_TYPE_TO_PROFILE[key] ?? profile;
}

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

// Error codes for the data-access verbs (describe_data / run_sql).
//
// run_sql's codes are deliberately specific rather than one generic
// INVALID_SQL: the agent's correct next move differs per failure. A
// SQL_NOT_READ_ONLY means "stop, this is not something you may do"; a
// SQL_MULTI_STATEMENT means "split it and retry"; an INVALID_MAX_ROWS means
// "fix the argument". A single opaque code would have the agent retry the
// forbidden statement.
export const DataCodes = {
  /** scope is not one of all / contract / semantic / listings. */
  UNSUPPORTED_SCOPE: 'UNSUPPORTED_SCOPE',
  /** object_name is not a plain three-part identifier. */
  INVALID_OBJECT_NAME: 'INVALID_OBJECT_NAME',
  /** sql contained only comments or whitespace. */
  SQL_EMPTY: 'SQL_EMPTY',
  /** sql contained more than one statement (semicolon-separated). */
  SQL_MULTI_STATEMENT: 'SQL_MULTI_STATEMENT',
  /** sql was not one of the allowed read-only leading keywords. */
  SQL_NOT_READ_ONLY: 'SQL_NOT_READ_ONLY',
  /** max_rows was not a positive integer. */
  INVALID_MAX_ROWS: 'INVALID_MAX_ROWS',
} as const;

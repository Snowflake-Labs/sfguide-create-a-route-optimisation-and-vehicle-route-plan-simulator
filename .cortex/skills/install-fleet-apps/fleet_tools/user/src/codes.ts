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

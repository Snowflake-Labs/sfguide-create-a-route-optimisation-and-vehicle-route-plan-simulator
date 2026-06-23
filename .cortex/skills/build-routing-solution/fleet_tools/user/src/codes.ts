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

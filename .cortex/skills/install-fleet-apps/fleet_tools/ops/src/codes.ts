// App-specific synapse error codes for the fleet-ops-tools bundle.
//
// `ctx.fail(code, msg)` accepts any string code, so these compose with the
// framework-canonical Codes without wrapping. A code thrown from a verb's
// `validate` hook is preserved by the envelope: it lands in the
// verb_attempt.error_code audit column AND propagates to the caller, so the
// operator/agent gets a typed, explainable failure instead of an opaque
// downstream SQL error.
export const OpsCodes = {
  /** region is not a provisioned (DEPLOYED) routing region. */
  REGION_NOT_PROVISIONED: 'REGION_NOT_PROVISIONED',
  /** set_active_context was called with neither region nor vehicle_type. */
  NO_CONTEXT_VALUE: 'NO_CONTEXT_VALUE',

  // ---- region lifecycle -------------------------------------------------
  /** compute_size was not one of S/M/L/XL/XXL. */
  INVALID_COMPUTE_SIZE: 'INVALID_COMPUTE_SIZE',
  /**
   * A destructive verb was called without confirm=true.
   *
   * A typed refusal rather than a prompt, so the agent cannot "helpfully"
   * default the flag: the envelope records the refusal in VERB_ATTEMPT and the
   * agent has to go back to the user.
   */
  CONFIRMATION_REQUIRED: 'CONFIRMATION_REQUIRED',
  /**
   * Refused to drop the ACTIVE region. Dropping it does not fail loudly - every
   * dashboard and semantic view binds to it, so the app just renders empty.
   */
  REGION_IS_ACTIVE: 'REGION_IS_ACTIVE',

  // ---- dataset generation ------------------------------------------------
  /** vehicle_type was not one of the supported asset modes. */
  INVALID_VEHICLE_TYPE: 'INVALID_VEHICLE_TYPE',
  /** days / entity_count outside the accepted range. */
  INVALID_GENERATION_PARAM: 'INVALID_GENERATION_PARAM',
  /** The studio worker image tag could not be resolved. */
  STUDIO_IMAGE_UNRESOLVED: 'STUDIO_IMAGE_UNRESOLVED',

  // ---- cost controls -----------------------------------------------------
  /** scale_services was given a non-positive or non-integer instance count. */
  INVALID_SCALE: 'INVALID_SCALE',
  /** hibernate_settings idle_hours outside the accepted range. */
  INVALID_IDLE_HOURS: 'INVALID_IDLE_HOURS',
} as const;

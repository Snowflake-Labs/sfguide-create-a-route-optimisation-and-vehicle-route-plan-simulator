// App-specific synapse error codes for the fleet-admin-tools bundle.
//
// `ctx.fail(code, msg)` accepts any string code, so these compose with the
// framework-canonical Codes without wrapping. A code thrown from a verb's
// `validate` hook is preserved by the envelope: it lands in the
// verb_attempt.error_code audit column AND propagates to the caller, so the
// admin/agent gets a typed, explainable failure instead of an opaque downstream
// SQL error.
export const AdminCodes = {
  /** region is not a provisioned (DEPLOYED) routing region. */
  REGION_NOT_PROVISIONED: 'REGION_NOT_PROVISIONED',
} as const;

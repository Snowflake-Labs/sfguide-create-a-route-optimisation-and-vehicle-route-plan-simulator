/**
 * Framework-canonical error codes. Apps extend with their own codes via
 * a sibling `Codes` object that intersects with the value type `string`.
 *
 * `fail()` accepts any string code so app codes work without wrapping.
 */
export const Codes = {
  BAD_VALUE_TYPE:       'BAD_VALUE_TYPE',
  WRONG_STATE_FOR_VERB: 'WRONG_STATE_FOR_VERB',
  INSUFFICIENT_ROLE:    'INSUFFICIENT_ROLE',
  NOT_FOUND:            'NOT_FOUND',
  /**
   * LOCAL PATCH (see VENDOR.md): another attempt with the same idempotency key
   * is still in flight, so this call refused to execute rather than duplicate it.
   */
  CONCURRENT_ATTEMPT:   'CONCURRENT_ATTEMPT',
  UNKNOWN:              'UNKNOWN',
} as const;

export type Code = string;

export class SynapseError extends Error {
  constructor(public readonly code: Code, message: string) {
    super(`${code}: ${message}`);
    this.name = 'SynapseError';
  }
}

export function fail(code: Code, msg: string): never {
  throw new SynapseError(code, msg);
}

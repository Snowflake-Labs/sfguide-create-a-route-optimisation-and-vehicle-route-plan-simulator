/**
 * Framework-canonical error codes. Apps extend with their own codes via
 * a sibling `Codes` object that intersects with the value type `string`.
 *
 * `fail()` accepts any string code so app codes work without wrapping.
 */
export const Codes = {
    BAD_VALUE_TYPE: 'BAD_VALUE_TYPE',
    WRONG_STATE_FOR_VERB: 'WRONG_STATE_FOR_VERB',
    INSUFFICIENT_ROLE: 'INSUFFICIENT_ROLE',
    NOT_FOUND: 'NOT_FOUND',
    UNKNOWN: 'UNKNOWN',
};
export class SynapseError extends Error {
    code;
    constructor(code, message) {
        super(`${code}: ${message}`);
        this.code = code;
        this.name = 'SynapseError';
    }
}
export function fail(code, msg) {
    throw new SynapseError(code, msg);
}
//# sourceMappingURL=errors.js.map
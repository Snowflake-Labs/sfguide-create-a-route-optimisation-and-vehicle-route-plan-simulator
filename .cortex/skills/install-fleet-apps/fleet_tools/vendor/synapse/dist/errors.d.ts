/**
 * Framework-canonical error codes. Apps extend with their own codes via
 * a sibling `Codes` object that intersects with the value type `string`.
 *
 * `fail()` accepts any string code so app codes work without wrapping.
 */
export declare const Codes: {
    readonly BAD_VALUE_TYPE: "BAD_VALUE_TYPE";
    readonly WRONG_STATE_FOR_VERB: "WRONG_STATE_FOR_VERB";
    readonly INSUFFICIENT_ROLE: "INSUFFICIENT_ROLE";
    readonly NOT_FOUND: "NOT_FOUND";
    readonly UNKNOWN: "UNKNOWN";
};
export type Code = string;
export declare class SynapseError extends Error {
    readonly code: Code;
    constructor(code: Code, message: string);
}
export declare function fail(code: Code, msg: string): never;
//# sourceMappingURL=errors.d.ts.map
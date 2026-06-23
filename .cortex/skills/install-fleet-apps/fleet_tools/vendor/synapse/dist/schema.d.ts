/**
 * Schema kind tag. The DDL emitter walks this tree to map TS schemas to SQL types
 * (`string` -> STRING, `number` -> FLOAT, etc.). The local-runtime parse() path
 * never reads `kind`; it's purely metadata for build-time tooling.
 */
export type SchemaKind = 'string' | 'uuid' | 'boolean' | 'number' | 'array' | 'object' | 'nullable' | 'enum';
export interface Schema<T> {
    readonly _t: T;
    readonly kind: SchemaKind;
    /** Set on `array` and `nullable`. */
    readonly inner?: Schema<unknown>;
    /** Set on `object`. */
    readonly shape?: Record<string, Schema<unknown>>;
    /** Set on `enum`. The allowed string-literal values, in declaration order. */
    readonly values?: readonly string[];
    /**
     * Human-readable gloss surfaced into JSON Schema (`description`) at build
     * time, which propagates to MCP `inputSchema` tool definitions. Set via
     * `.describe(text)`. Build-time metadata only — `parse()` ignores it.
     */
    readonly description?: string;
    parse(value: unknown, path?: string): T;
    nullable(): Schema<T | null>;
    /** Return a shallow copy of this schema with `description` set. */
    describe(text: string): Schema<T>;
}
export type Infer<S> = S extends Schema<infer T> ? T : never;
export type InferRecord<R extends Record<string, Schema<unknown>>> = {
    [K in keyof R]: Infer<R[K]>;
};
export interface StringOpts {
    min?: number;
    max?: number;
    regex?: RegExp;
}
export declare const t: {
    string: (opts?: StringOpts) => Schema<string>;
    uuid: () => Schema<string>;
    boolean: () => Schema<boolean>;
    number: () => Schema<number>;
    array: <T>(inner: Schema<T>) => Schema<T[]>;
    object: <R extends Record<string, Schema<unknown>>>(shape: R) => Schema<InferRecord<R>>;
    enum: <T extends string>(values: readonly T[]) => Schema<T>;
};
//# sourceMappingURL=schema.d.ts.map
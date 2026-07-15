/**
 * Embed `value` as a Snowflake plain dollar-quoted string literal (`$$...$$`).
 *
 * Why dollar-quoting: a single-quoted SQL literal forces the JSON payload to
 * survive TWO escape layers (SQL `''` doubling AND JSON `\"` escaping). When a
 * free-text field contains a literal `"`, the resulting `\"...\"` sequence inside
 * a single-quoted SQL string trips Snowflake's PARSE_JSON. Dollar-quoted literals
 * pass their contents through verbatim.
 *
 * Snowflake's dollar-quote syntax is plain `$$...$$` ONLY (no Postgres tags).
 * Every `$` in the serialised JSON is replaced with the JSON unicode escape
 * `\u0024` so the SQL lexer never sees a stray `$`; the receiving JSON parser
 * decodes `\u0024` back to `$`, preserving semantics.
 */
export declare function asSqlJsonLiteral(value: unknown): string;
/**
 * Strip characters from free-text fields that are noisy or harmful when embedded
 * inside a JSON value or surfaced to an LLM / debug logs. The data layer
 * (asSqlJsonLiteral) is already escape-proof; this just keeps diagnostics readable.
 */
export declare function safeText(s: string | null | undefined, maxLen?: number): string;
/**
 * Sanitize a SQL identifier (region/schema/object name) that cannot be bound as a
 * parameter. Allows letters, digits, and underscore only. Throws on violation so
 * callers fail loudly rather than build an injectable string.
 */
export declare function sanitizeIdent(name: string): string;
//# sourceMappingURL=index.d.ts.map
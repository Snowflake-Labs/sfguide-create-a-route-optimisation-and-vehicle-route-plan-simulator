// Pure SQL string helpers shared by both apps (R1). Extracted from the control
// app's src/lib/sfQuery.ts (the asSqlJsonLiteral + safeText helpers). No deps.
//
// asSqlJsonLiteral is the canonical guard against the repo's entire class of
// "silent [] return" JSON-in-SQL escape bugs (free-text POI names / addresses /
// listing text with apostrophes, backslashes, or double-quotes).
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
export function asSqlJsonLiteral(value) {
    const json = JSON.stringify(value).replace(/\$/g, '\\u0024');
    return `$$${json}$$`;
}
/**
 * Strip characters from free-text fields that are noisy or harmful when embedded
 * inside a JSON value or surfaced to an LLM / debug logs. The data layer
 * (asSqlJsonLiteral) is already escape-proof; this just keeps diagnostics readable.
 */
export function safeText(s, maxLen = 80) {
    return String(s ?? '')
        .replace(/["\\\n\r\t]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, maxLen);
}
/**
 * Sanitize a SQL identifier (region/schema/object name) that cannot be bound as a
 * parameter. Allows letters, digits, and underscore only. Throws on violation so
 * callers fail loudly rather than build an injectable string.
 */
export function sanitizeIdent(name) {
    const raw = String(name ?? '');
    if (!/^[A-Za-z0-9_]+$/.test(raw)) {
        throw new Error(`Invalid SQL identifier: ${JSON.stringify(name)}`);
    }
    return raw;
}
//# sourceMappingURL=index.js.map
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { sfQuery, asSqlJsonLiteral, safeText } from './sfQuery';

describe('asSqlJsonLiteral', () => {
  it('wraps the JSON in plain $$...$$ (Snowflake-supported dollar quotes)', () => {
    expect(asSqlJsonLiteral({ a: 1 })).toBe('$$' + '{"a":1}' + '$$');
  });

  it('round-trips a literal double-quote without breaking PARSE_JSON-ready output', () => {
    // The historic bug: terminal name like `"Mansheim Clemens Spedition"` (with
    // literal quotes in the data) used to land inside a SQL single-quoted
    // string as `\"...\"` - Snowflake then choked on PARSE_JSON. The dollar-
    // quoted form embeds the JSON.stringify output verbatim, so the JSON
    // parser sees the standard `\"` escape and accepts it.
    const out = asSqlJsonLiteral({ description: '"Mansheim Clemens Spedition" (WAREHOUSE)' });
    expect(out).toContain('\\"Mansheim Clemens Spedition\\"');
    // Crucially: no single-quote escaping nonsense is needed.
    expect(out).not.toContain("''");
    // And the wrapper is plain $$...$$ (the form the Snowflake REST API parses).
    expect(out.startsWith('$$')).toBe(true);
    expect(out.endsWith('$$')).toBe(true);
  });

  it("handles apostrophes without doubling them (no '' gymnastics needed)", () => {
    const out = asSqlJsonLiteral({ name: "O'Reilly's Truckstop" });
    expect(out).toContain("O'Reilly's Truckstop");
    expect(out).not.toContain("''");
  });

  it('escapes literal $ with \\u0024 to prevent dollar-quote collisions', () => {
    // A payload containing a literal `$` (or worse, `$$`) would otherwise
    // prematurely close the dollar-quoted SQL literal. We escape every `$`
    // to the JSON unicode form `\u0024`; PARSE_JSON decodes it back to `$`.
    const out = asSqlJsonLiteral({ price: '$100', collide: '$$' });
    // The wrapper itself contains only the surrounding $$.
    expect(out.startsWith('$$')).toBe(true);
    expect(out.endsWith('$$')).toBe(true);
    // The body has zero literal `$` characters between the wrappers.
    const body = out.slice(2, -2);
    expect(body).not.toContain('$');
    // Both `$` chars from the input were rewritten as \u0024.
    expect(body).toContain('\\u0024100');
    expect(body).toContain('\\u0024\\u0024');
  });

  it('handles backslashes and newlines without re-escaping', () => {
    const out = asSqlJsonLiteral({ s: 'line1\nline2\\path' });
    // JSON.stringify escapes \n -> \\n and \\ -> \\\\
    expect(out).toContain('line1\\nline2\\\\path');
  });
});

describe('safeText', () => {
  it('strips literal double-quotes', () => {
    expect(safeText('"foo"')).toBe('foo');
  });

  it('collapses whitespace and trims', () => {
    expect(safeText('  hello\n\tworld  ')).toBe('hello world');
  });

  it('truncates to the given max length', () => {
    expect(safeText('x'.repeat(200), 10)).toBe('xxxxxxxxxx');
  });

  it('handles null/undefined safely', () => {
    expect(safeText(null)).toBe('');
    expect(safeText(undefined)).toBe('');
  });
});

describe('sfQuery', () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it('returns the result array on success', async () => {
    globalThis.fetch = vi.fn(async () => ({
      json: async () => ({ result: [{ A: 1 }, { A: 2 }] }),
    } as any)) as any;
    const rows = await sfQuery('SELECT 1');
    expect(rows).toEqual([{ A: 1 }, { A: 2 }]);
  });

  it('returns [] on body.error when throwOnError is false', async () => {
    globalThis.fetch = vi.fn(async () => ({
      json: async () => ({ error: 'syntax error' }),
    } as any)) as any;
    const rows = await sfQuery('OOPS');
    expect(rows).toEqual([]);
  });

  it('throws on body.error when throwOnError is true', async () => {
    globalThis.fetch = vi.fn(async () => ({
      json: async () => ({ error: 'invalid identifier FOO' }),
    } as any)) as any;
    await expect(sfQuery('OOPS', 'D', 'S', { throwOnError: true })).rejects.toThrow(/invalid identifier FOO/);
  });

  it('throws on network error when throwOnError is true', async () => {
    globalThis.fetch = vi.fn(async () => {
      throw new Error('network down');
    }) as any;
    await expect(sfQuery('SELECT 1', 'D', 'S', { throwOnError: true })).rejects.toThrow(/network down/);
  });

  it('returns [] when fetch returns a bare array (legacy shape)', async () => {
    globalThis.fetch = vi.fn(async () => ({
      json: async () => [{ A: 1 }],
    } as any)) as any;
    const rows = await sfQuery('SELECT 1');
    expect(rows).toEqual([{ A: 1 }]);
  });
});

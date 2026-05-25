import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { sfQuery, asSqlJsonLiteral, safeText } from './sfQuery';

describe('asSqlJsonLiteral', () => {
  it('wraps the JSON in the static dollar-quote tag', () => {
    expect(asSqlJsonLiteral({ a: 1 })).toBe('$_SF_JSON_${"a":1}$_SF_JSON_$');
  });

  it('round-trips a literal double-quote without breaking PARSE_JSON-ready output', () => {
    // The historic bug: terminal name like `"Mansheim Clemens Spedition"` (with
    // literal quotes in the data) used to land inside a SQL single-quoted
    // string as `\"...\"` — Snowflake then choked on PARSE_JSON. The dollar-
    // quoted form embeds the JSON.stringify output verbatim, so the JSON
    // parser sees the standard `\"` escape and accepts it.
    const out = asSqlJsonLiteral({ description: '"Mansheim Clemens Spedition" (WAREHOUSE)' });
    // The serialised JSON is `{"description":"\"Mansheim Clemens Spedition\" (WAREHOUSE)"}`
    expect(out).toContain('\\"Mansheim Clemens Spedition\\"');
    // Crucially: no single-quote escaping nonsense is needed.
    expect(out).not.toContain("''");
  });

  it("handles apostrophes without doubling them (no '' gymnastics needed)", () => {
    const out = asSqlJsonLiteral({ name: "O'Reilly's Truckstop" });
    expect(out).toContain("O'Reilly's Truckstop");
    expect(out).not.toContain("''");
  });

  it('uses a unique delimiter when payload collides with the static tag', () => {
    // Construct a payload that contains the static delimiter as content.
    const collide = { x: '$_SF_JSON_$' };
    const out = asSqlJsonLiteral(collide);
    expect(out.startsWith('$_SF_JSON_$')).toBe(false);
    expect(out).toMatch(/^\$_SF_JSON_[A-Z0-9]+_\$/);
    // Round-trip the inner JSON and verify it's intact.
    const start = out.indexOf('{');
    const end = out.lastIndexOf('}') + 1;
    expect(JSON.parse(out.slice(start, end))).toEqual(collide);
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

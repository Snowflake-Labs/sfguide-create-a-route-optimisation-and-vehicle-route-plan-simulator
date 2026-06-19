import { describe, it, expect } from 'vitest';
import { validatePageSpec, buildQuery, toSqlLiteral, gridTokens, type BindingScope } from './spec-runtime';
import type { PageSpec } from './spec-types';
import { dwellOverviewSpec } from './specs/dwellOverview';
import { congestionMapSpec } from './specs/congestionMap';

// Built-in component strings are always recognized by validatePageSpec, so an
// empty registry set is sufficient to validate the converted dashboards
// without importing the React/deck.gl registry into the node test env.
const NO_CUSTOM = new Set<string>();

describe('validatePageSpec', () => {
  it('accepts the converted dwell:overview spec', () => {
    expect(validatePageSpec(dwellOverviewSpec, NO_CUSTOM)).toEqual([]);
  });

  it('accepts the converted dwell:congestion spec', () => {
    expect(validatePageSpec(congestionMapSpec, NO_CUSTOM)).toEqual([]);
  });

  it('flags a grid token with no matching area', () => {
    const bad: PageSpec = {
      id: 'bad',
      layout: { default: { columns: '1fr', rows: '1fr', grid: '"ghost"' } },
      areas: {
        real: { component: 'Table', data: { query: 'SELECT 1' } },
      },
    };
    const errs = validatePageSpec(bad, NO_CUSTOM);
    expect(errs.some((e) => e.includes('ghost'))).toBe(true);
  });

  it('flags an unknown component', () => {
    const bad: PageSpec = {
      id: 'bad2',
      layout: { default: { columns: '1fr', rows: '1fr', grid: '"x"' } },
      areas: { x: { component: 'NopeWidget' } },
    };
    expect(validatePageSpec(bad, NO_CUSTOM).some((e) => e.includes('NopeWidget'))).toBe(true);
  });
});

describe('buildQuery / toSqlLiteral', () => {
  const scope: BindingScope = {
    region: { regionName: 'SanFrancisco', displayName: 'SF', center: { lat: 0, lng: 0 }, zoom: 11, boundaryGeoJson: null },
    vehicle: { vehicleType: 'ebike', activeDatasetId: null },
    viewState: { selectedStatus: "O'Brien", limit: 25 },
  };

  it('resolves params from viewState and inlines literals', () => {
    const sql = buildQuery(
      { query: 'SELECT * FROM T WHERE STATUS = :status AND N < :n', params: { status: 'viewState.selectedStatus', n: 'viewState.limit' } },
      scope,
    );
    // string param single-quote-escaped, number param raw
    expect(sql).toBe("SELECT * FROM T WHERE STATUS = 'O''Brien' AND N < 25");
  });

  it('resolves region path params', () => {
    const sql = buildQuery({ query: 'SELECT :r', params: { r: 'region.regionName' } }, scope);
    expect(sql).toBe("SELECT 'SanFrancisco'");
  });

  it('encodes nulls and booleans', () => {
    expect(toSqlLiteral(null)).toBe('NULL');
    expect(toSqlLiteral(undefined)).toBe('NULL');
    expect(toSqlLiteral(true)).toBe('TRUE');
    expect(toSqlLiteral(3.5)).toBe('3.5');
  });

  it('leaves queries without params untouched', () => {
    expect(buildQuery({ query: 'SELECT 1' }, scope)).toBe('SELECT 1');
  });
});

describe('gridTokens', () => {
  it('extracts unique area tokens and ignores empty cells', () => {
    const toks = gridTokens(`
      "metrics metrics"
      "trends  ."
    `);
    expect(new Set(toks)).toEqual(new Set(['metrics', 'trends']));
  });
});

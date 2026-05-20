import { describe, it, expect } from 'vitest';
import { generateSql, isProvisionedRegion, type RegionOption } from './helpers';

const SF_BBOX = { min_lat: 37.71, max_lat: 37.81, min_lon: -122.51, max_lon: -122.37 };

const sfDefault: RegionOption = {
  region: 'SanFrancisco',
  display_name: 'San Francisco',
  isDefault: true,
  bbox: SF_BBOX,
};

const namedRegion: RegionOption = {
  region: 'Germany',
  display_name: 'Germany',
  isDefault: false,
  bbox: { min_lat: 47.27, max_lat: 55.05, min_lon: 5.86, max_lon: 15.04 },
};

describe('helpers.generateSql region threading (post default-sentinel retirement)', () => {
  it('emits the explicit default region name (not NULL::VARCHAR) for the default region', () => {
    const sql = generateSql('DIRECTIONS', sfDefault, 'driving-car', 'OPENROUTESERVICE_APP');
    expect(sql).toContain("'SanFrancisco'");
    expect(sql).not.toContain('NULL::VARCHAR');
  });

  it('emits the explicit region name for a named region', () => {
    const sql = generateSql('DIRECTIONS', namedRegion, 'driving-car', 'OPENROUTESERVICE_APP');
    expect(sql).toContain("'Germany'");
    expect(sql).not.toContain('NULL::VARCHAR');
  });

  it('falls back to NULL::VARCHAR only when no region is selected', () => {
    const sql = generateSql('DIRECTIONS', null, 'driving-car', 'OPENROUTESERVICE_APP');
    expect(sql).toContain('NULL::VARCHAR');
  });

  it('threads region into ISOCHRONES, MATRIX, MATRIX_TABULAR, OPTIMIZATION, ORS_STATUS', () => {
    for (const fn of ['ISOCHRONES', 'MATRIX', 'MATRIX_TABULAR', 'OPTIMIZATION', 'ORS_STATUS']) {
      const sql = generateSql(fn, sfDefault, 'driving-car', 'OPENROUTESERVICE_APP');
      expect(sql, `function ${fn} should embed region`).toContain("'SanFrancisco'");
    }
  });

  it('treats default region as provisioned (no longer suppressed)', () => {
    expect(isProvisionedRegion(sfDefault)).toBe(true);
    expect(isProvisionedRegion(namedRegion)).toBe(true);
    expect(isProvisionedRegion(null)).toBe(false);
  });
});

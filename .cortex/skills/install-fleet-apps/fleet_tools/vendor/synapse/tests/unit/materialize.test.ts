import { describe, it, expect } from 'vitest';
import { pickDeployRole } from '../../src/cli/materialize.js';

/**
 * LOCAL PATCH guard (see ../../VENDOR.md, deploy-role patch).
 *
 * install.sql emits `USE ROLE <deployRole>` and then creates the audit hybrid table,
 * the verb procedures, the MCP server, and the grants - so the deploy role must be an
 * installer-grade role. Upstream's chain starts at `roles.admin`, which in this repo
 * names a CONSUMER app role (FLEET_APP_ADMIN), and with one binding per bundle it
 * resolves to the consumer role for every bundle. The result is a total deploy
 * failure on CREATE OR REPLACE HYBRID TABLE, with nothing installed.
 *
 * These cases pin the `deploy`-first precedence and the preserved fallback chain.
 */
describe('cli/materialize > pickDeployRole', () => {
  it('prefers an explicit deploy role over admin', () => {
    // The regression case: `admin` is bound to a consumer app role, so starting the
    // chain there deploys as FLEET_APP_ADMIN and cannot create the audit table.
    expect(pickDeployRole({ deploy: 'ACCOUNTADMIN', admin: 'FLEET_APP_ADMIN' }))
      .toBe('ACCOUNTADMIN');
  });

  it('prefers deploy over a sole app-role binding', () => {
    // user/ops bundles: one binding each, which upstream would take via the
    // first-key fallback.
    expect(pickDeployRole({ deploy: 'ACCOUNTADMIN', user: 'FLEET_APP_USER' }))
      .toBe('ACCOUNTADMIN');
  });

  it('falls back to admin, then owner, then the first binding', () => {
    // Upstream behaviour preserved for apps where `admin` IS the installer role.
    expect(pickDeployRole({ admin: 'APP_ADMIN', owner: 'APP_OWNER', viewer: 'V' }))
      .toBe('APP_ADMIN');
    expect(pickDeployRole({ owner: 'APP_OWNER', viewer: 'V' })).toBe('APP_OWNER');
    expect(pickDeployRole({ viewer: 'V' })).toBe('V');
  });

  it('returns undefined for an empty roles map so the caller can fail loudly', () => {
    expect(pickDeployRole({})).toBeUndefined();
  });
});

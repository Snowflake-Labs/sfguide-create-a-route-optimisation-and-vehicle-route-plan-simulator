import { describe, it, expect } from 'vitest';
import { defaultAuditSink } from '../../src/audit.js';
import { mockConn } from '../../src/testing/index.js';

// LOCAL PATCH (see VENDOR.md patch 06). These tests exist because the failure
// they cover is silent: the claim table is emitted as a HYBRID table only where
// hybrid tables exist, and a STANDARD Snowflake table does not enforce PRIMARY
// KEY. An unconditional `INSERT` therefore always succeeds there, the
// PK-violation catch never fires, and the guard permits exactly the double
// execution of a mutating verb it was added to block.
describe('defaultAuditSink.claim', () => {
  const ident = { user: 'U', role: 'R' };

  it('claims with a conditional insert, so the guard does not depend on an enforced PK', async () => {
    const conn = mockConn({
      rows: [{ match: /INSERT INTO CLAIMS/i, rows: [{ 'number of rows inserted': 1 }] }],
    });
    const sink = defaultAuditSink({ table: 'ATT', claimTable: 'CLAIMS' });
    await expect(sink.claim!(conn, ident, 'v', 'k1')).resolves.toBe(true);

    const sql = conn.calls[0]!.sql;
    expect(sql).toMatch(/INSERT INTO CLAIMS/i);
    expect(sql).toMatch(/WHERE NOT EXISTS/i);
    // One statement, not a read followed by a write: this is the interactive
    // verb path, and a second round trip here is paid on every mutating call.
    expect(conn.calls).toHaveLength(1);
    // Both halves of the statement bind the same triple.
    expect(conn.calls[0]!.binds).toEqual(['U', 'v', 'k1', 'U', 'v', 'k1']);
  });

  it('loses the claim when the conditional insert writes no row', async () => {
    const conn = mockConn({
      rows: [{ match: /INSERT INTO CLAIMS/i, rows: [{ 'number of rows inserted': 0 }] }],
    });
    const sink = defaultAuditSink({ table: 'ATT', claimTable: 'CLAIMS' });
    // This is the case a standard (PK-unenforced) claim table can only express
    // as a zero count - no exception is raised - so returning false here is
    // what keeps the guard alive on GCP / trial / SnowGov accounts.
    await expect(sink.claim!(conn, ident, 'v', 'k1')).resolves.toBe(false);
  });

  it('still loses the claim on an enforced-PK violation (concurrent hybrid case)', async () => {
    const conn = mockConn();
    conn.execScalar = async () => {
      throw new Error('A primary key already exists.');
    };
    const sink = defaultAuditSink({ table: 'ATT', claimTable: 'CLAIMS' });
    await expect(sink.claim!(conn, ident, 'v', 'k1')).resolves.toBe(false);
  });

  it('rethrows a non-violation error rather than silently allowing execution', async () => {
    const conn = mockConn();
    conn.execScalar = async () => {
      throw new Error('Insufficient privileges to operate on table');
    };
    const sink = defaultAuditSink({ table: 'ATT', claimTable: 'CLAIMS' });
    await expect(sink.claim!(conn, ident, 'v', 'k1')).rejects.toThrow(/Insufficient privileges/);
  });

  it('issues no statement when there is no idempotency key', async () => {
    const conn = mockConn();
    const sink = defaultAuditSink({ table: 'ATT', claimTable: 'CLAIMS' });
    await expect(sink.claim!(conn, ident, 'v', null)).resolves.toBe(true);
    expect(conn.calls).toHaveLength(0);
  });
});

import { describe, it, expect } from 'vitest';
import { defineProc, t } from '../../src/index.js';
import { createSynapseRuntime } from '../../src/runtime/index.js';
import { mockConn, mockSink } from '../../src/testing/index.js';

// LOCAL PATCH 10. A routing verb returns `{ result, rows }` on success and
// `{ result }` on failure. CoWork treats a `rows` key as a drawable row set, so a
// nullable return key the proc did not set must stay ABSENT, not become null.
const verb = defineProc({
  name: 'draw',
  args: { ok: t.boolean() },
  returns: {
    result: t.object({}),
    rows: t.array(t.object({})).nullable(),
  },
  execute: async (args) =>
    (args.ok ? { result: { status: 'SUCCESS' }, rows: [{ LON: 1, LAT: 2 }] } : { result: { status: 'FAILED' } }) as never,
});

describe('omitted nullable returns stay omitted', () => {
  const rt = () => createSynapseRuntime({ connector: mockConn(), procs: { verb }, audit: mockSink() });

  it('keeps rows when the proc set them', async () => {
    expect(await rt().verb({ ok: true })).toEqual({ result: { status: 'SUCCESS' }, rows: [{ LON: 1, LAT: 2 }] });
  });

  it('does not invent rows: null when the proc left them out', async () => {
    const out = await rt().verb({ ok: false });
    expect(out).toEqual({ result: { status: 'FAILED' } });
    expect('rows' in (out as object)).toBe(false);
  });
});

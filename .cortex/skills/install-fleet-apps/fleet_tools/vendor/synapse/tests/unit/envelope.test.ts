import { describe, it, expect } from 'vitest';
import { defineProc, t, SynapseError } from '../../src/index.js';
import { createSynapseRuntime } from '../../src/runtime/index.js';
import { mockConn, mockSink } from '../../src/testing/index.js';

const noop = defineProc({
  name: 'noop',
  args:    { x: t.string() },
  returns: { ok: t.boolean(), echoed: t.string() },
  execute: async (args) => ({ ok: true, echoed: args.x }),
});

const exploder = defineProc({
  name: 'exploder',
  args:    { x: t.string() },
  returns: { ok: t.boolean() },
  execute: async (_args, ctx) => {
    ctx.fail('WRONG_STATE_FOR_VERB', 'always fails');
  },
});

describe('envelope', () => {
  it('happy path: validate -> identity -> checkReplay -> execute -> auditOk', async () => {
    const conn = mockConn();
    const sink = mockSink();
    const rt = createSynapseRuntime({ connector: conn, procs: { noop }, audit: sink });

    const result = await rt.noop({ x: 'hi' }, { idempotency_key: 'k1' });

    expect(result).toEqual({ ok: true, echoed: 'hi' });
    expect(sink.events).toHaveLength(1);
    expect(sink.events[0]?.outcome).toBe('ok');
    expect(sink.events[0]?.verb).toBe('noop');
    expect(sink.events[0]?.actor).toBe('TEST_USER');
    expect(sink.events[0]?.idempotency_key).toBe('k1');
  });

  it('arg validation failure throws BAD_VALUE_TYPE without auditing', async () => {
    const conn = mockConn();
    const sink = mockSink();
    const rt = createSynapseRuntime({ connector: conn, procs: { noop }, audit: sink });

    await expect(rt.noop({ x: 42 } as never)).rejects.toThrow(SynapseError);
    await expect(rt.noop({ x: 42 } as never)).rejects.toMatchObject({ code: 'BAD_VALUE_TYPE' });
    expect(sink.events).toHaveLength(0);
  });

  it('execute throw triggers auditError with the right code', async () => {
    const conn = mockConn();
    const sink = mockSink();
    const rt = createSynapseRuntime({ connector: conn, procs: { exploder }, audit: sink });

    await expect(rt.exploder({ x: 'whatever' })).rejects.toMatchObject({
      code: 'WRONG_STATE_FOR_VERB',
    });
    expect(sink.events).toHaveLength(1);
    expect(sink.events[0]?.outcome).toBe('error');
    expect(sink.events[0]?.error_code).toBe('WRONG_STATE_FOR_VERB');
  });

  it('replay hit: returns sentinel without calling execute (ok prior)', async () => {
    const conn = mockConn();
    const sink = mockSink({
      replay: {
        replayed: true, outcome: 'ok',
        result_hash: 'abc123', error_code: null, error_message: null,
      },
    });
    const rt = createSynapseRuntime({ connector: conn, procs: { noop }, audit: sink });

    const out = await rt.noop({ x: 'ignored' }, { idempotency_key: 'k1' });
    expect(out).toEqual({ replayed: true, result_hash: 'abc123' });
    expect(sink.events).toHaveLength(0);
    expect(sink.replays).toBe(1);
  });

  it('replay hit: throws prior error (error prior)', async () => {
    const conn = mockConn();
    const sink = mockSink({
      replay: {
        replayed: true, outcome: 'error',
        result_hash: null, error_code: 'WRONG_STATE_FOR_VERB',
        error_message: 'previously failed',
      },
    });
    const rt = createSynapseRuntime({ connector: conn, procs: { noop }, audit: sink });

    await expect(rt.noop({ x: 'whatever' }, { idempotency_key: 'k1' })).rejects.toMatchObject({
      code: 'WRONG_STATE_FOR_VERB',
      message: expect.stringContaining('previously failed'),
    });
    expect(sink.events).toHaveLength(1);
    expect(sink.events[0]?.outcome).toBe('error');
  });

  // Idempotency claim (LOCAL PATCH, see VENDOR.md). The guard exists because
  // checkReplay is a read-before-write with no lock, so two concurrent callers
  // sharing a key would both miss and both execute.
  describe('idempotency claim', () => {
    let executed = 0;
    const counter = defineProc({
      name: 'counter',
      args:    { x: t.string() },
      returns: { ok: t.boolean() },
      execute: async () => { executed++; return { ok: true }; },
    });

    it('winning the claim proceeds to execute', async () => {
      executed = 0;
      const sink = mockSink({ claim: true });
      const rt = createSynapseRuntime({ connector: mockConn(), procs: { counter }, audit: sink });

      await expect(rt.counter({ x: 'a' }, { idempotency_key: 'k1' })).resolves.toEqual({ ok: true });
      expect(sink.claims).toBe(1);
      expect(executed).toBe(1);
    });

    it('losing the claim does NOT execute, and replays the winner result', async () => {
      executed = 0;
      const sink = mockSink({
        claim: false,
        replay: null,
        replayOnRace: {
          replayed: true, outcome: 'ok',
          result_hash: 'winner-hash', error_code: null, error_message: null,
        },
      });
      const rt = createSynapseRuntime({ connector: mockConn(), procs: { counter }, audit: sink });

      const out = await rt.counter({ x: 'a' }, { idempotency_key: 'k1' });
      expect(out).toEqual({ replayed: true, result_hash: 'winner-hash' });
      expect(executed).toBe(0);
    });

    it('losing the claim with the winner still in flight refuses rather than double-executing', async () => {
      executed = 0;
      const sink = mockSink({ claim: false, replay: null, replayOnRace: null });
      const rt = createSynapseRuntime({ connector: mockConn(), procs: { counter }, audit: sink });

      await expect(rt.counter({ x: 'a' }, { idempotency_key: 'k1' })).rejects.toMatchObject({
        code: 'CONCURRENT_ATTEMPT',
      });
      expect(executed).toBe(0);
      // The refusal is itself audited as an error.
      expect(sink.events).toHaveLength(1);
      expect(sink.events[0]?.error_code).toBe('CONCURRENT_ATTEMPT');
    });

    it('no idempotency key means no claim statement at all (agent steady state)', async () => {
      executed = 0;
      const sink = mockSink({ claim: true });
      const rt = createSynapseRuntime({ connector: mockConn(), procs: { counter }, audit: sink });

      await expect(rt.counter({ x: 'a' })).resolves.toEqual({ ok: true });
      expect(sink.claims).toBe(0);
      expect(executed).toBe(1);
    });

    it('a sink without claim support still executes (upstream compatibility)', async () => {
      executed = 0;
      const sink = mockSink();
      const rt = createSynapseRuntime({ connector: mockConn(), procs: { counter }, audit: sink });

      await expect(rt.counter({ x: 'a' }, { idempotency_key: 'k1' })).resolves.toEqual({ ok: true });
      expect(executed).toBe(1);
    });
  });
});

import type { Conn } from '../connector.js';
import type { AuditSink, AuditEvent, Identity, ReplayHit } from '../audit.js';

export interface MockMatch {
  match: RegExp;
  rows: Record<string, unknown>[];
  respond?: (sql: string, binds: unknown[]) => Record<string, unknown>[];
}

export interface MockCall {
  sql: string;
  binds: unknown[];
}

export interface MockConn extends Conn {
  calls: MockCall[];
}

export function mockConn(opts: { rows?: MockMatch[] } = {}): MockConn {
  const matchers = opts.rows ?? [];
  const calls: MockCall[] = [];

  function matchRows(sql: string, binds: unknown[]): Record<string, unknown>[] {
    for (const m of matchers) {
      if (m.match.test(sql)) {
        return m.respond ? m.respond(sql, binds) : m.rows;
      }
    }
    return [];
  }

  const conn: MockConn = {
    calls,
    exec: async <R = Record<string, unknown>>(sql: string, binds: unknown[] = []) => {
      calls.push({ sql, binds });
      return matchRows(sql, binds) as unknown as R[];
    },
    execRow: async <R = Record<string, unknown>>(sql: string, binds: unknown[] = []) => {
      calls.push({ sql, binds });
      const rows = matchRows(sql, binds);
      if (rows.length === 0) return null;
      return rows[0] as unknown as R;
    },
    execScalar: async <T = unknown>(sql: string, binds: unknown[] = []) => {
      calls.push({ sql, binds });
      const rows = matchRows(sql, binds);
      if (rows.length === 0) return null;
      const first = rows[0]!;
      const keys = Object.keys(first);
      if (keys.length === 0) return null;
      return first[keys[0]!] as unknown as T;
    },
    close: async () => {},
  };
  return conn;
}

export interface MockSinkOpts {
  identity?: Identity;
  replay?: ReplayHit | null;
  /**
   * When set, the sink implements the optional `claim` method and returns this
   * value. Leave undefined to model an upstream sink that has no claim support,
   * which is what the envelope must keep tolerating.
   */
  claim?: boolean;
  /**
   * Replay result for the SECOND and later `checkReplay` calls - i.e. the
   * re-check the envelope performs after LOSING a claim. Defaults to `replay`.
   */
  replayOnRace?: ReplayHit | null;
}

export interface MockSink extends AuditSink {
  events: AuditEvent[];
  readonly replays: number;
  readonly claims: number;
}

export function mockSink(opts: MockSinkOpts = {}): MockSink {
  const events: AuditEvent[] = [];
  let replays = 0;
  let claims = 0;
  let checkReplayCalls = 0;
  const ident = opts.identity ?? { user: 'TEST_USER', role: 'TEST_ROLE' };
  const sink: MockSink = {
    events,
    get replays() { return replays; },
    get claims() { return claims; },
    async identity() { return ident; },
    async checkReplay(_conn, _ident, _verb, idemKey) {
      const nth = ++checkReplayCalls;
      const hit = nth === 1
        ? opts.replay
        : (opts.replayOnRace !== undefined ? opts.replayOnRace : opts.replay);
      if (idemKey && hit) {
        replays++;
        return hit;
      }
      return null;
    },
    async recordOk(_conn, event) { events.push(event); },
    async recordError(_conn, event) { events.push(event); },
  };
  if (opts.claim !== undefined) {
    sink.claim = async () => { claims++; return opts.claim as boolean; };
  }
  return sink;
}

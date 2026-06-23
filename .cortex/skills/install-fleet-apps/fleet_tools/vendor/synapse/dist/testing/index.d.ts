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
export declare function mockConn(opts?: {
    rows?: MockMatch[];
}): MockConn;
export interface MockSinkOpts {
    identity?: Identity;
    replay?: ReplayHit | null;
}
export interface MockSink extends AuditSink {
    events: AuditEvent[];
    readonly replays: number;
}
export declare function mockSink(opts?: MockSinkOpts): MockSink;
//# sourceMappingURL=index.d.ts.map
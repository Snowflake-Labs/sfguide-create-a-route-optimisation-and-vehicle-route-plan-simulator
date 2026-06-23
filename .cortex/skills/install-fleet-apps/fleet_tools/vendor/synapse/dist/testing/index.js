export function mockConn(opts = {}) {
    const matchers = opts.rows ?? [];
    const calls = [];
    function matchRows(sql, binds) {
        for (const m of matchers) {
            if (m.match.test(sql)) {
                return m.respond ? m.respond(sql, binds) : m.rows;
            }
        }
        return [];
    }
    const conn = {
        calls,
        exec: async (sql, binds = []) => {
            calls.push({ sql, binds });
            return matchRows(sql, binds);
        },
        execRow: async (sql, binds = []) => {
            calls.push({ sql, binds });
            const rows = matchRows(sql, binds);
            if (rows.length === 0)
                return null;
            return rows[0];
        },
        execScalar: async (sql, binds = []) => {
            calls.push({ sql, binds });
            const rows = matchRows(sql, binds);
            if (rows.length === 0)
                return null;
            const first = rows[0];
            const keys = Object.keys(first);
            if (keys.length === 0)
                return null;
            return first[keys[0]];
        },
        close: async () => { },
    };
    return conn;
}
export function mockSink(opts = {}) {
    const events = [];
    let replays = 0;
    const ident = opts.identity ?? { user: 'TEST_USER', role: 'TEST_ROLE' };
    const sink = {
        events,
        get replays() { return replays; },
        async identity() { return ident; },
        async checkReplay(_conn, _ident, _verb, idemKey) {
            if (idemKey && opts.replay) {
                replays++;
                return opts.replay;
            }
            return null;
        },
        async recordOk(_conn, event) { events.push(event); },
        async recordError(_conn, event) { events.push(event); },
    };
    return sink;
}
//# sourceMappingURL=index.js.map
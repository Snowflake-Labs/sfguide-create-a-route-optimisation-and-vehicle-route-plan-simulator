import { defineProc, t } from '@snowflake/synapse';

// Surfaces the synapse audit trail (VERB_ATTEMPT) for the Ops Console / ops
// agent. Until now every bundle WROTE a VERB_ATTEMPT row per call but nothing
// ever READ it back, so the envelope's audit investment was invisible. This
// read-only verb closes that gap (Tenet 7): an operator can review who invoked
// which verb, the outcome (ok / error / idempotent_replay), error codes, and
// the idempotency key, across all three role-scoped bundles.
//
// Why it can read all three schemas without extra grants: synapse procs run
// EXECUTE AS OWNER, and a clean install deploys all three bundles under the same
// connection/role, so the proc owner owns SYNAPSE_OPS.VERB_ATTEMPT,
// SYNAPSE_USER (routing) lives in OPENROUTESERVICE_APP.ROUTING.VERB_ATTEMPT, and
// SYNAPSE_ADMIN.VERB_ATTEMPT. Each source is queried best-effort (try/catch) so a
// partial/older deploy that is missing one table still returns the rest. Ops-only.
const SOURCES: { bundle: string; table: string }[] = [
  { bundle: 'user', table: 'OPENROUTESERVICE_APP.ROUTING.VERB_ATTEMPT' },
  { bundle: 'ops', table: 'FLEET_INTELLIGENCE.SYNAPSE_OPS.VERB_ATTEMPT' },
  { bundle: 'admin', table: 'FLEET_INTELLIGENCE.SYNAPSE_ADMIN.VERB_ATTEMPT' },
];

export const recent_verb_attempts = defineProc({
  name: 'recent_verb_attempts',
  description:
    'Review the synapse audit trail (VERB_ATTEMPT) across the routing, ops, and ' +
    'admin tool bundles: who called which verb, the outcome (ok/error/' +
    'idempotent_replay), error code/message, and idempotency key. Optionally ' +
    'filter by verb name or outcome and cap the row count. Read-only. Ops-only.',
  roles: ['ops'],
  args: {
    limit: t
      .number()
      .nullable()
      .describe('Max rows to return (most recent first). Default 50, capped at 500.'),
    verb: t.string({ max: 200 }).nullable().describe('Optional exact verb-name filter, e.g. optimize_routes.'),
    outcome: t
      .enum(['ok', 'error', 'idempotent_replay'])
      .nullable()
      .describe('Optional outcome filter: ok, error, or idempotent_replay.'),
  },
  returns: {
    count: t.number().describe('Number of attempt rows returned.'),
    attempts: t
      .array(t.object({}))
      .describe('Recent audit rows: {bundle, id, at, verb, actor, actor_role, outcome, error_code, error_message, idempotency_key, args_json}.'),
  },
  execute: async (args, ctx) => {
    const limit = Math.min(Math.max(Number(args.limit ?? 50), 1), 500);
    const verbFilter = args.verb && String(args.verb).trim() ? String(args.verb).trim() : null;
    const outcomeFilter = args.outcome ?? null;

    type Row = {
      BUNDLE: string;
      ID: string;
      AT: string;
      VERB: string;
      ACTOR: string;
      ACTOR_ROLE: string;
      OUTCOME: string;
      ERROR_CODE: string | null;
      ERROR_MESSAGE: string | null;
      IDEMPOTENCY_KEY: string | null;
      ARGS_JSON: string | null;
    };

    const all: Row[] = [];
    for (const src of SOURCES) {
      // Per-source overfetch to `limit`; the merged set is re-sorted and capped
      // below so the global "most recent N" is correct across bundles.
      const where: string[] = [];
      const binds: unknown[] = [];
      if (verbFilter) {
        where.push('VERB = ?');
        binds.push(verbFilter);
      }
      if (outcomeFilter) {
        where.push('OUTCOME = ?');
        binds.push(outcomeFilter);
      }
      const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
      const sql =
        `SELECT '${src.bundle}' AS BUNDLE, ID, TO_VARCHAR(AT) AS AT, VERB, ACTOR, ACTOR_ROLE, ` +
        `OUTCOME, ERROR_CODE, ERROR_MESSAGE, IDEMPOTENCY_KEY, TO_VARCHAR(ARGS_JSON) AS ARGS_JSON ` +
        `FROM ${src.table} ${whereSql} ORDER BY AT DESC LIMIT ${limit}`;
      try {
        const rows = (await ctx.conn.exec<Row>(sql, binds)) as Row[];
        if (Array.isArray(rows)) all.push(...rows);
      } catch {
        /* table missing (partial/older deploy) or no privilege: skip this source */
      }
    }

    all.sort((a, b) => (a.AT < b.AT ? 1 : a.AT > b.AT ? -1 : 0));
    const top = all.slice(0, limit);
    const attempts = top.map((r) => ({
      bundle: r.BUNDLE,
      id: r.ID,
      at: r.AT,
      verb: r.VERB,
      actor: r.ACTOR,
      actor_role: r.ACTOR_ROLE,
      outcome: r.OUTCOME,
      error_code: r.ERROR_CODE,
      error_message: r.ERROR_MESSAGE,
      idempotency_key: r.IDEMPOTENCY_KEY,
      args_json: r.ARGS_JSON,
    }));
    return { count: attempts.length, attempts };
  },
});

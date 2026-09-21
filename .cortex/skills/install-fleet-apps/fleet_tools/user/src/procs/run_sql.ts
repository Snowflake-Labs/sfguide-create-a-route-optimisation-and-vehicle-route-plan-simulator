import { defineProc, t } from '@snowflake/synapse';
import { DataCodes } from '../codes.js';

/**
 * Read-only SQL escape hatch.
 *
 * WHY THIS EXISTS
 * ---------------
 * The nine (now eleven) Cortex Analyst semantic views cover the modelled
 * domains, but several real things in this deployment are modelled by NO
 * semantic view: safety events, work items, region provisioning state, dataset
 * inventory. Before this verb existed the agent's only honest answer to those
 * questions was "I cannot query that", while the data sat in plain views the
 * caller's own role could read.
 *
 * SAFETY MODEL - read this before widening anything
 * -------------------------------------------------
 * The real security boundary is the SYNAPSE ROLE, not this allowlist. The verb
 * executes with the bundle's role (FLEET_APP_USER for the user bundle), so it
 * can only ever touch what that role was already granted. The allowlist exists
 * to stop an ACCIDENT - an agent talking itself into a DELETE while "cleaning
 * up" - not to contain a determined caller. Three guards:
 *
 *   1. comments are stripped BEFORE the leading keyword is read, so
 *      `/* x *\/ DROP TABLE t` cannot masquerade as a comment-led SELECT
 *   2. exactly one statement: any semicolon that is not trailing is rejected,
 *      which is what stops `SELECT 1; DROP TABLE t`
 *   3. the leading keyword must be SELECT / WITH / SHOW / DESCRIBE / DESC /
 *      EXPLAIN - an allowlist, never a denylist, because a denylist of
 *      dangerous verbs is a guessing game
 *
 * Every call is written to VERB_ATTEMPT by the synapse envelope (Tenet 7), which
 * is what makes free SQL acceptable here at all: it is auditable after the fact.
 *
 * TRUNCATION IS REPORTED, NOT HIDDEN
 * ----------------------------------
 * A clipped result presented as complete is a correctness bug, so the verb
 * returns `truncated` and `row_limit` and the agent is instructed to say so.
 */

const ALLOWED_LEADING = ['SELECT', 'WITH', 'SHOW', 'DESCRIBE', 'DESC', 'EXPLAIN'];

const DEFAULT_ROWS = 100;
const MAX_ROWS = 1000;

/**
 * True when a dollar-quote delimiter starts at `k`.
 *
 * Deliberately tests two single '$' characters instead of comparing against a
 * two-character literal. Snowflake has no custom dollar-quote tag (unlike
 * Postgres) so the synapse codegen must wrap every procedure body in a bare
 * dollar-quote delimiter, which means writing that delimiter literally ANYWHERE
 * in a bundled verb closes the body early. That produced a SQL compilation
 * error on the generated CREATE PROCEDURE, failed `synapse deploy`, and aborted
 * the whole install at the bundle step - so no roles, agents or apps were
 * created. Keeping the token out of the source keeps it out of the bundle, and
 * is bundler-proof: an expression like '$' + '$' would be constant-folded back
 * into the literal this has to avoid. install_synapse_bundles.sh greps the verb
 * sources for it, so even a mention in a comment fails the build by design.
 */
function isDollarQuote(s: string, k: number): boolean {
  return s.charAt(k) === '$' && s.charAt(k + 1) === '$';
}

/** Index of the next dollar-quote delimiter at or after `from`, else -1. */
function findDollarQuote(s: string, from: number): number {
  for (let k = from; k < s.length - 1; k += 1) {
    if (isDollarQuote(s, k)) return k;
  }
  return -1;
}

/**
 * Strip SQL comments and string literals so the structural checks cannot be
 * fooled by their contents.
 *
 * Literals are blanked (not removed) so a semicolon inside `'a;b'` does not read
 * as a statement separator, while character positions stay stable.
 */
function stripNoise(sql: string): string {
  let out = '';
  let i = 0;
  const n = sql.length;
  while (i < n) {
    const two = sql.slice(i, i + 2);
    if (two === '--') {
      const nl = sql.indexOf('\n', i);
      i = nl === -1 ? n : nl;
      continue;
    }
    if (two === '/*') {
      const close = sql.indexOf('*/', i + 2);
      i = close === -1 ? n : close + 2;
      continue;
    }
    const ch = sql[i];
    if (ch === "'" || ch === '"') {
      const quote = ch;
      out += ' ';
      i += 1;
      while (i < n) {
        if (sql[i] === quote) {
          // Doubled quote is an escaped quote, not a terminator.
          if (sql[i + 1] === quote) {
            i += 2;
            continue;
          }
          i += 1;
          break;
        }
        i += 1;
      }
      continue;
    }
    if (isDollarQuote(sql, i)) {
      out += ' ';
      const close = findDollarQuote(sql, i + 2);
      i = close === -1 ? n : close + 2;
      continue;
    }
    out += ch;
    i += 1;
  }
  return out;
}

/**
 * Detect that the submitted SQL targets an object a Cortex Analyst tool already
 * models, and return a directive naming it. Null when nothing matches.
 *
 * WHY THIS IS IN THE RESULT AND NOT IN AN INSTRUCTION
 * "Prefer a query_* tool when one models the data" is already stated in the agent
 * spec's orchestration section AND in this verb's own tool description. Measured
 * on tib85385, the agent still used run_sql to query
 * FLEET_APP.DWELL.VW_DWELL_SESSIONS and
 * FLEET_INTELLIGENCE.ROUTE_DEVIATION.TRIP_DEVIATION_ANALYSIS, both modelled by
 * query_dwell and query_route_deviation. Two copies of the same guidance lost, so
 * a third would not have helped; this puts the fact in a result the model has to
 * read, at the moment it is relevant.
 *
 * It does NOT block the call. run_sql exists for the genuinely unmodelled
 * questions - safety events, region provisioning state, INFORMATION_SCHEMA
 * lookups - which are most of its legitimate use. Refusing the query would break
 * that; naming the better tool does not.
 *
 * The mapping comes from INFORMATION_SCHEMA.SEMANTIC_TABLES, the semantic views'
 * own declared base tables, so it cannot drift from the semantic layer. Note
 * ACCOUNT_USAGE.OBJECT_DEPENDENCIES is NOT usable for this: it records
 * dependencies for VIEW objects but emits no rows at all for a SEMANTIC VIEW.
 *
 * The semantic VIEW is named rather than the tool, because the view-to-tool
 * binding lives in each agent's own spec (tool_resources) and not in Snowflake
 * metadata. The agent knows its own binding; guessing a tool name here would be
 * inventing one.
 *
 * Never throws. A failure here must not fail an otherwise good query, so the
 * catch returns null: the caller loses a hint, not their answer.
 */
// Exported for verify_run_sql.mts. A silent no-match here would make the whole
// nudge inert while everything still looked healthy, which is the same failure
// shape as the guidance it replaces - so it is tested directly with a stub conn.
export async function governedNote(
  ctx: { conn: { exec: <T>(sql: string) => T[] | Promise<T[]> } },
  sql: string,
): Promise<string | null> {
  try {
    const upper = sql.toUpperCase();
    const governed =
      (await ctx.conn.exec<{
        SEMANTIC_VIEW_NAME: string;
        BASE_TABLE_CATALOG: string;
        BASE_TABLE_SCHEMA: string;
        BASE_TABLE_NAME: string;
      }>(
        `SELECT DISTINCT SEMANTIC_VIEW_NAME, BASE_TABLE_CATALOG, BASE_TABLE_SCHEMA, BASE_TABLE_NAME
           FROM FLEET_INTELLIGENCE.INFORMATION_SCHEMA.SEMANTIC_TABLES
          WHERE SEMANTIC_VIEW_SCHEMA = 'SEMANTIC'`,
      )) ?? [];

    const hits = new Map<string, string[]>();
    for (const g of governed) {
      const fqn =
        `${g.BASE_TABLE_CATALOG}.${g.BASE_TABLE_SCHEMA}.${g.BASE_TABLE_NAME}`.toUpperCase();
      const shortName = `${g.BASE_TABLE_SCHEMA}.${g.BASE_TABLE_NAME}`.toUpperCase();
      // Both forms, because the agent writes both: fully qualified, and the
      // schema-qualified short form after a USE.
      if (!upper.includes(fqn) && !upper.includes(shortName)) continue;
      const list = hits.get(g.SEMANTIC_VIEW_NAME) ?? [];
      list.push(fqn);
      hits.set(g.SEMANTIC_VIEW_NAME, list);
    }

    if (hits.size === 0) return null;

    const parts = [...hits.entries()].map(
      ([sv, objs]) => `${sv} (models ${[...new Set(objs)].join(', ')})`,
    );
    return (
      `This query read data that a Cortex Analyst semantic view already models: ${parts.join('; ')}. ` +
      'That is the governed path - it carries the agreed metric definitions, so a hand-written ' +
      'aggregate here can silently disagree with the rest of the app. Tell the user the result ' +
      'came from raw SQL, name the query_* tool bound to that semantic view, and offer to ' +
      're-answer through it. If you had a specific reason raw SQL was necessary (a column or ' +
      'join the view does not expose), say what it was.'
    );
  } catch {
    return null;
  }
}

export const run_sql = defineProc({
  name: 'run_sql',
  description:
    'Run a READ-ONLY SQL query against this account and return the rows. Use ONLY when no ' +
    'semantic view models the data: prefer the query_* Cortex Analyst tools whenever one covers ' +
    'the question, because they are the governed path. Good uses: something no semantic view ' +
    'models (safety events, work items, region or dataset inventory), a precise lookup, a ' +
    'join across contract views, or querying the ROUTING_PLATFORM.CONTRACT functions ' +
    '(DIRECTIONS, ISOCHRONES, OPTIMIZATION, MATRIX, SNAP, MATCH) for live routing geometry ' +
    'or distance/duration that no semantic view projects. Only SELECT, WITH, SHOW, DESCRIBE ' +
    'and EXPLAIN are accepted - anything that writes is rejected - and exactly one statement ' +
    'per call. Results are capped (100 rows by default, 1000 maximum) and the response ' +
    'reports whether it was truncated; if it was, say so rather than presenting a partial ' +
    'answer as complete. Call describe_data first if you need the schema.',
  roles: ['user'],
  args: {
    sql: t
      .string({ min: 1, max: 20000 })
      .describe(
        'One read-only SQL statement (SELECT / WITH / SHOW / DESCRIBE / EXPLAIN). No trailing ' +
          'semicolon needed. Qualify names fully, e.g. FLEET_APP.FLEET_OPS.VW_TRIPS.',
      ),
    max_rows: t
      .number()
      .nullable()
      .describe('Maximum rows to return. Defaults to 100, hard ceiling 1000.'),
  },
  returns: {
    row_count: t.number().describe('Rows returned (after the cap).'),
    truncated: t
      .boolean()
      .describe('True when the query had more rows than the cap. Tell the user when true.'),
    row_limit: t.number().describe('The cap that was applied.'),
    rows: t.array(t.object({})).describe('The result rows.'),
    governed_note: t
      .string()
      .nullable()
      .describe(
        'Set when the query targeted an object that a Cortex Analyst semantic view ' +
          'already models. When present you MUST relay it: say which governed tool ' +
          'covers this data and offer to re-answer through it.',
      ),
  },
  validate: async (args, ctx) => {
    const raw = String(args.sql ?? '');
    const cleaned = stripNoise(raw).trim();

    if (cleaned === '') {
      ctx.fail(DataCodes.SQL_EMPTY, 'sql contains no statement (only comments or whitespace)');
      return;
    }

    // Guard 2 before guard 3: a multi-statement payload must be rejected even if
    // its FIRST statement is a legitimate SELECT.
    const withoutTrailing = cleaned.replace(/;\s*$/, '');
    if (withoutTrailing.includes(';')) {
      ctx.fail(
        DataCodes.SQL_MULTI_STATEMENT,
        'sql must contain exactly one statement; a semicolon separating statements was found. ' +
          'Send one query per call.',
      );
      return;
    }

    const leading = (withoutTrailing.match(/^[A-Za-z]+/) ?? [''])[0].toUpperCase();
    if (!ALLOWED_LEADING.includes(leading)) {
      ctx.fail(
        DataCodes.SQL_NOT_READ_ONLY,
        `only read-only statements are allowed (${ALLOWED_LEADING.join(', ')}); this one starts ` +
          `with "${leading || '?'}". This verb cannot create, alter, drop, insert, update, ` +
          'delete, merge, copy, call or grant.',
      );
      return;
    }

    if (args.max_rows != null) {
      const m = Number(args.max_rows);
      if (!Number.isFinite(m) || m <= 0 || Math.floor(m) !== m) {
        ctx.fail(DataCodes.INVALID_MAX_ROWS, 'max_rows must be a positive integer');
      }
    }
  },
  execute: async (args, ctx) => {
    const limit =
      args.max_rows != null && Number.isFinite(args.max_rows) && args.max_rows > 0
        ? Math.min(Math.floor(args.max_rows), MAX_ROWS)
        : DEFAULT_ROWS;

    // Strip a trailing semicolon: harmless alone, but it breaks the subquery wrap
    // below and Snowflake rejects it inside a single-statement call anyway.
    const sql = String(args.sql).trim().replace(/;\s*$/, '');

    const leading = (stripNoise(sql).trim().match(/^[A-Za-z]+/) ?? [''])[0].toUpperCase();

    // SHOW / DESCRIBE / EXPLAIN are not sub-queryable, so they cannot be wrapped
    // to enforce the cap - fetch and slice client-side instead. SELECT and WITH
    // are wrapped so the cap is applied server-side and a huge result never
    // crosses the wire.
    //
    // One extra row is requested so "there were more" is a fact rather than an
    // inference from row_count == limit.
    const metadataOnly = leading === 'SHOW' || leading === 'DESCRIBE' || leading === 'DESC' || leading === 'EXPLAIN';

    let rows: Record<string, unknown>[];
    if (metadataOnly) {
      rows = (await ctx.conn.exec<Record<string, unknown>>(sql)) ?? [];
    } else {
      rows =
        (await ctx.conn.exec<Record<string, unknown>>(
          `SELECT * FROM (${sql}) LIMIT ${limit + 1}`,
        )) ?? [];
    }

    const truncated = rows.length > limit;
    if (truncated) rows = rows.slice(0, limit);

    return {
      row_count: rows.length,
      truncated,
      row_limit: limit,
      rows,
      governed_note: await governedNote(ctx, sql),
    };
  },
});

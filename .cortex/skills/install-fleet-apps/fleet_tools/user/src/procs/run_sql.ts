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
    if (two === '$$') {
      out += ' ';
      const close = sql.indexOf('$$', i + 2);
      i = close === -1 ? n : close + 2;
      continue;
    }
    out += ch;
    i += 1;
  }
  return out;
}

export const run_sql = defineProc({
  name: 'run_sql',
  description:
    'Run a READ-ONLY SQL query against this account and return the rows. Use ONLY when no ' +
    'semantic view models the data: prefer the query_* Cortex Analyst tools whenever one covers ' +
    'the question, because they are the governed path. Good uses: something no semantic view ' +
    'models (safety events, work items, region or dataset inventory), a precise lookup, or a ' +
    'join across contract views. Only SELECT, WITH, SHOW, DESCRIBE and EXPLAIN are accepted - ' +
    'anything that writes is rejected - and exactly one statement per call. Results are capped ' +
    '(100 rows by default, 1000 maximum) and the response reports whether it was truncated; if ' +
    'it was, say so rather than presenting a partial answer as complete. Call describe_data ' +
    'first if you need the schema.',
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
    };
  },
});

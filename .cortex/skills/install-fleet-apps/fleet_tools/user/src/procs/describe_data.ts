import { defineProc, t } from '@snowflake/synapse';
import { DataCodes } from '../codes.js';

/**
 * Live data dictionary for this deployment.
 *
 * WHY THIS EXISTS
 * ---------------
 * The agent's analytical reach was nine Cortex Analyst semantic views, and it
 * had no way to answer "what tables does this use", "what marketplace data is
 * this built on", or "what columns are in that view". Those questions were being
 * answered from the agent's instruction text, which goes stale the moment a pack
 * is added, or not at all.
 *
 * This reads INFORMATION_SCHEMA at call time, so it cannot go stale, and it
 * covers the three surfaces a user actually asks about:
 *   contract  - the neutral FLEET_APP.* views the dashboards and SVs bind to
 *               (Tenet 1 data seam: this is the layer a customer would rebind)
 *   semantic  - the FLEET_INTELLIGENCE.SEMANTIC.* semantic views, i.e. exactly
 *               which questions have a governed text-to-SQL path
 *   listings  - the acquired Snowflake Marketplace databases, reported by
 *               probing for them rather than from a hardcoded list, so a
 *               deployment missing one is visible instead of assumed
 *
 * Read-only: SELECTs over INFORMATION_SCHEMA and SHOW-equivalent metadata only.
 */

// The marketplace databases the installer acquires (analytic_layer.sql). Listed
// here as the set to PROBE for, not as the answer: each is reported present or
// absent from the account so a missing acquisition surfaces honestly.
const LISTING_DBS: { db: string; purpose: string }[] = [
  { db: 'OVERTURE_MAPS__PLACES', purpose: 'POI pool: catchment, store estate, health anchors' },
  { db: 'OVERTURE_MAPS__ADDRESSES', purpose: 'address / household proxy, evacuation participants' },
  { db: 'OVERTURE_MAPS__TRANSPORTATION', purpose: 'road segments, matrix road filter, road sampling' },
  { db: 'OVERTURE_MAPS__BUILDINGS', purpose: 'building polygons -> depot centroids' },
  { db: 'OVERTURE_MAPS__DIVISIONS', purpose: 'admin polygons -> region boundaries' },
  { db: 'SAFEGRAPH_OPEN_CENSUS_FREE', purpose: 'US census demographics for the demographics generator' },
];

const SCOPES = ['all', 'contract', 'semantic', 'listings'] as const;

function parseJsonArray(json: unknown): Record<string, unknown>[] {
  if (json == null) return [];
  try {
    const parsed = JSON.parse(String(json));
    return Array.isArray(parsed) ? (parsed as Record<string, unknown>[]) : [];
  } catch {
    return [];
  }
}

export const describe_data = defineProc({
  name: 'describe_data',
  description:
    'Describe the data this deployment is built on: the neutral FLEET_APP contract views the ' +
    'dashboards and semantic views read, the FLEET_INTELLIGENCE.SEMANTIC semantic views (which ' +
    'questions have a governed text-to-SQL path), and the Snowflake Marketplace databases that ' +
    'have been acquired. Use for "what tables/data does this use", "what is the data model", ' +
    '"which marketplace listings are installed", "what semantic views exist", or - with ' +
    'object_name - "what columns are in <view>". Read-only metadata: it reads INFORMATION_SCHEMA ' +
    'and returns no customer data, so it is always safe to call and never stale.',
  roles: ['user'],
  args: {
    scope: t
      .string({ max: 20 })
      .nullable()
      .describe(
        'What to describe: "contract" (FLEET_APP.* neutral views), "semantic" (the semantic ' +
          'views), "listings" (acquired Marketplace databases), or "all". Defaults to "all".',
      ),
    object_name: t
      .string({ max: 300 })
      .nullable()
      .describe(
        'Optional. A fully qualified view or table name (e.g. "FLEET_APP.FLEET_OPS.VW_TRIPS") ' +
          'to return the column list and data types for. When set, scope is ignored.',
      ),
  },
  returns: {
    result: t
      .object({})
      .describe(
        'Either { object, columns[] } when object_name is given, or { contract, semantic, ' +
          'listings } rollups plus a short summary sentence.',
      ),
  },
  validate: async (args, ctx) => {
    const scope = (args.scope ?? '').trim().toLowerCase();
    if (scope !== '' && !SCOPES.includes(scope as (typeof SCOPES)[number])) {
      ctx.fail(
        DataCodes.UNSUPPORTED_SCOPE,
        `scope must be one of ${SCOPES.join(', ')} (got "${args.scope}")`,
      );
    }
    const name = (args.object_name ?? '').trim();
    if (name !== '') {
      // Three parts, identifier characters only. This value is interpolated into
      // the INFORMATION_SCHEMA database name (which cannot be bound), so it must
      // be validated rather than trusted.
      if (!/^[A-Za-z0-9_$]+\.[A-Za-z0-9_$]+\.[A-Za-z0-9_$]+$/.test(name)) {
        ctx.fail(
          DataCodes.INVALID_OBJECT_NAME,
          'object_name must be a fully qualified DATABASE.SCHEMA.OBJECT name using only ' +
            'letters, digits, underscore and $ (no quotes, no spaces)',
        );
      }
    }
  },
  execute: async (args, ctx) => {
    const objectName = (args.object_name ?? '').trim();

    // ---- single-object column listing -------------------------------------
    if (objectName !== '') {
      const [db, schema, obj] = objectName.split('.');
      // The database qualifier of INFORMATION_SCHEMA cannot be bound, hence the
      // strict identifier check in validate above.
      const json = await ctx.conn.execScalar<string>(
        `SELECT COALESCE(ARRAY_AGG(OBJECT_CONSTRUCT(
             'column_name', COLUMN_NAME,
             'data_type', DATA_TYPE,
             'nullable', IS_NULLABLE,
             'comment', COMMENT
           )) WITHIN GROUP (ORDER BY ORDINAL_POSITION), ARRAY_CONSTRUCT())::STRING
         FROM ${db}.INFORMATION_SCHEMA.COLUMNS
         WHERE UPPER(TABLE_SCHEMA) = UPPER(?) AND UPPER(TABLE_NAME) = UPPER(?)`,
        [schema, obj],
      );
      const columns = parseJsonArray(json);
      return {
        result: {
          object: objectName.toUpperCase(),
          column_count: columns.length,
          columns,
          summary:
            columns.length === 0
              ? `${objectName.toUpperCase()} has no columns visible to this role - it may not exist, or the role may lack access.`
              : `${objectName.toUpperCase()} has ${columns.length} column(s).`,
        },
      };
    }

    const scope = (args.scope ?? 'all').trim().toLowerCase() || 'all';
    const want = (s: string) => scope === 'all' || scope === s;
    const result: Record<string, unknown> = { scope };
    const notes: string[] = [];

    // ---- neutral contract views -------------------------------------------
    if (want('contract')) {
      const json = await ctx.conn.execScalar<string>(
        `SELECT COALESCE(ARRAY_AGG(OBJECT_CONSTRUCT('schema', s, 'views', v))
                  WITHIN GROUP (ORDER BY s), ARRAY_CONSTRUCT())::STRING
         FROM (
           SELECT TABLE_SCHEMA AS s, ARRAY_AGG(TABLE_NAME) WITHIN GROUP (ORDER BY TABLE_NAME) AS v
           FROM FLEET_APP.INFORMATION_SCHEMA.VIEWS
           WHERE TABLE_SCHEMA <> 'INFORMATION_SCHEMA'
           GROUP BY TABLE_SCHEMA
         )`,
      );
      const contract = parseJsonArray(json);
      const total = contract.reduce(
        (n, row) => n + (Array.isArray(row.views) ? (row.views as unknown[]).length : 0),
        0,
      );
      result.contract = {
        database: 'FLEET_APP',
        description:
          'The neutral data seam (Tenet 1). Dashboards, semantic views and the agent bind here, ' +
          'never to a physical source, so a customer swaps their own data in by repointing these.',
        schema_count: contract.length,
        view_count: total,
        schemas: contract,
      };
      notes.push(`${total} contract view(s) across ${contract.length} schema(s) in FLEET_APP`);
    }

    // ---- semantic views ----------------------------------------------------
    if (want('semantic')) {
      // SHOW SEMANTIC VIEWS is the only reliable enumeration; INFORMATION_SCHEMA
      // does not expose them consistently across versions.
      let semantic: Record<string, unknown>[] = [];
      try {
        const rows = await ctx.conn.exec<Record<string, unknown>>(
          `SHOW SEMANTIC VIEWS IN SCHEMA FLEET_INTELLIGENCE.SEMANTIC`,
        );
        semantic = (rows ?? []).map((r) => ({
          name: r.name ?? r.NAME,
          comment: r.comment ?? r.COMMENT,
        }));
      } catch {
        notes.push('semantic views could not be listed (schema missing or not granted)');
      }
      result.semantic = {
        schema: 'FLEET_INTELLIGENCE.SEMANTIC',
        description:
          'Cortex Analyst semantic views. Each one is a governed text-to-SQL path, so a question ' +
          'answerable here should be answered with the matching query_* tool rather than free SQL.',
        count: semantic.length,
        views: semantic,
      };
      if (semantic.length) notes.push(`${semantic.length} semantic view(s)`);
    }

    // ---- marketplace listings ---------------------------------------------
    if (want('listings')) {
      const listings: Record<string, unknown>[] = [];
      for (const l of LISTING_DBS) {
        let present = false;
        try {
          const n = await ctx.conn.execScalar<number>(
            `SELECT COUNT(*) FROM INFORMATION_SCHEMA.DATABASES WHERE UPPER(DATABASE_NAME) = UPPER(?)`,
            [l.db],
          );
          present = Number(n ?? 0) > 0;
        } catch {
          present = false;
        }
        listings.push({ database: l.db, purpose: l.purpose, present });
      }
      const have = listings.filter((l) => l.present).length;
      result.listings = {
        description:
          'Snowflake Marketplace databases the installer acquires. Shared data read in place - ' +
          'nothing is copied into the account.',
        acquired: have,
        expected: listings.length,
        databases: listings,
      };
      notes.push(`${have}/${listings.length} marketplace database(s) acquired`);
    }

    result.summary = notes.length
      ? `This deployment: ${notes.join('; ')}.`
      : 'Nothing matched the requested scope.';
    return { result };
  },
});

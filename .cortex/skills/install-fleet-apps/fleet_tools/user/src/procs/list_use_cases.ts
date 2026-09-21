import { defineProc, t } from '@snowflake/synapse';

/**
 * Deterministic listing of the use cases THIS deployment can demonstrate.
 *
 * Complements the agent's `search_solution_catalog` Cortex Search tool: search
 * is right for "what fits a customer who complains about empty running", this
 * verb is right for "what can you show me" / "list the retail use cases", where
 * a complete, ordered answer matters more than relevance ranking.
 *
 * Reads FLEET_INTELLIGENCE.SEMANTIC.VIEW_CATALOG, which is generated from
 * app-views.json by scripts/build_view_catalog.py - so the app's in-panel "i"
 * overlay, the app's request-time catalog prefix, and the out-of-app agent all
 * describe the same views. Read-only.
 */
export const list_use_cases = defineProc({
  name: 'list_use_cases',
  description:
    'List the solution use cases (app views) this deployment can demonstrate, with the ' +
    'business question each answers, its audience, industries and the Snowflake capabilities ' +
    'it shows. Use for "what can you show me", "what use cases are available", "what should ' +
    'I demo to a retail customer", or "which view answers X". Optionally filter by domain ' +
    '(Core, Location, Asset Pool, Help) or by industry keyword. Read-only - returns the ' +
    'catalog, it does not run any analytics.',
  roles: ['user'],
  args: {
    domain: t
      .string({ max: 40 })
      .nullable()
      .describe('Optional domain filter: Core, Location, Asset Pool, or Help. Omit for all domains.'),
    industry: t
      .string({ max: 80 })
      .nullable()
      .describe('Optional industry keyword (e.g. "retail", "logistics", "public sector"). Matched case-insensitively against each use case\'s industries.'),
    max_results: t
      .number()
      .nullable()
      .describe('Maximum use cases to return. Defaults to 30 (the full catalog is small).'),
  },
  returns: {
    count: t.number().describe('Number of use cases returned.'),
    use_cases: t
      .array(t.object({}))
      .describe(
        'Catalog entries: view_id, label, domain, headline, business_question, audience, ' +
          'industries, value_drivers, snowflake_capabilities, caveats, preferred_tool.',
      ),
  },
  execute: async (args, ctx) => {
    const domain = args.domain != null && args.domain.trim() !== '' ? args.domain.trim() : null;
    const industry = args.industry != null && args.industry.trim() !== '' ? args.industry.trim() : null;
    const limit =
      args.max_results != null && Number.isFinite(args.max_results) && args.max_results > 0
        ? Math.min(Math.floor(args.max_results), 100)
        : 30;

    // ARRAY_TO_STRING on INDUSTRIES so the industry filter is a plain ILIKE
    // rather than a FLATTEN + EXISTS subquery.
    const json = await ctx.conn.execScalar<string>(
      `SELECT COALESCE(ARRAY_AGG(OBJECT_CONSTRUCT(
           'view_id', VIEW_ID,
           'label', LABEL,
           'domain', DOMAIN,
           'headline', HEADLINE,
           'business_question', BUSINESS_QUESTION,
           'audience', AUDIENCE,
           'industries', INDUSTRIES,
           'value_drivers', VALUE_DRIVERS,
           'snowflake_capabilities', SNOWFLAKE_CAPABILITIES,
           'caveats', CAVEATS,
           'preferred_tool', PREFERRED_TOOL
         )) WITHIN GROUP (ORDER BY DOMAIN, VIEW_ID), ARRAY_CONSTRUCT())::STRING
       FROM (
         SELECT *
         FROM FLEET_INTELLIGENCE.SEMANTIC.VIEW_CATALOG
         WHERE (? IS NULL OR UPPER(DOMAIN) = UPPER(?))
           AND (? IS NULL OR ARRAY_TO_STRING(INDUSTRIES, ', ') ILIKE '%' || ? || '%')
         ORDER BY DOMAIN, VIEW_ID
         LIMIT ${limit}
       )`,
      [domain, domain, industry, industry],
    );

    let rows: Record<string, unknown>[] = [];
    try {
      const parsed = json == null ? [] : JSON.parse(String(json));
      if (Array.isArray(parsed)) rows = parsed as Record<string, unknown>[];
    } catch {
      rows = [];
    }
    return { count: rows.length, use_cases: rows };
  },
});

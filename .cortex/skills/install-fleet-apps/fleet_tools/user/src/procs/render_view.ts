import { defineProc, t } from '@snowflake/synapse';
import { RenderCodes, RENDER_COMPONENTS } from '../codes.js';

// render_view: the agent emits a declarative page spec (the same ParsedViewDef
// shape the SA app's ViewRenderer interprets) and this verb validates + echoes
// it back. The value is the audited envelope (VERB_ATTEMPT records the prompt ->
// spec) and the tool_result surface: the SA chat client picks up the result and
// renders it as an ephemeral panel page. This verb intentionally does NOT touch
// data — area queries run later through /api/query under the owner's-rights
// FLEET_APP_DYNAMIC_READER boundary (see role_binding.sql). roles:['user'] ->
// it materializes onto ROUTING_MCP, the only server attached to the consumer agent.
export const render_view = defineProc({
  name: 'render_view',
  description:
    'Render a custom dashboard/page from a declarative spec when no existing saved view fits. ' +
    'Use for "build/show me a dashboard/page/view of ...". The spec is a JSON object with ' +
    '`layout.default` ({columns, rows, grid}) and `areas` (each {component, data:{query,params}, config?}). ' +
    'Allowed components: ' + RENDER_COMPONENTS.join(', ') + '. ' +
    'Area queries MUST read the neutral FLEET_APP contract, e.g. ' +
    'TABLE(FLEET_APP.CORE.F_FACT_*_SCOPED(CAST(:region AS VARCHAR), CAST(:dataset_id AS VARCHAR))) ' +
    'or FLEET_APP.<DWELL|CATCHMENT|ROUTE_OPTIMIZATION>.VW_*, with :region/:dataset_id/:date_range_* params. ' +
    'Fails with INVALID_SPEC_JSON, INVALID_SPEC_SHAPE, or UNKNOWN_COMPONENT. ' +
    'Prefer an existing saved view (a view: link) when one matches the request.',
  roles: ['user'],
  args: {
    spec_json: t
      .string({ min: 2, max: 60000 })
      .describe(
        'The view spec as a JSON object string: {label, category?, description?, ' +
        'layout:{default:{columns,rows?,grid}}, areas:{<name>:{component, data:{query,params,mapping?}, config?, emits?}}}.',
      ),
    title: t
      .string({ max: 200 })
      .nullable()
      .describe('Optional human title for the generated page; falls back to the spec label.'),
  },
  returns: {
    result: t
      .object({})
      .describe('The validated view spec (echoed) for the client to render as an ephemeral page.'),
  },
  validate: async (args, ctx) => {
    let spec: unknown;
    try {
      spec = JSON.parse(args.spec_json);
    } catch (e) {
      ctx.fail(RenderCodes.INVALID_SPEC_JSON, `spec_json is not valid JSON: ${(e as Error).message}`);
      return;
    }
    if (typeof spec !== 'object' || spec === null || Array.isArray(spec)) {
      ctx.fail(RenderCodes.INVALID_SPEC_JSON, 'spec_json must be a JSON object.');
      return;
    }
    const s = spec as Record<string, unknown>;
    const layout = s.layout as { default?: { grid?: unknown } } | undefined;
    if (!layout || typeof layout !== 'object' || !layout.default || typeof layout.default.grid !== 'string') {
      ctx.fail(RenderCodes.INVALID_SPEC_SHAPE, 'spec.layout.default.grid (string) is required.');
      return;
    }
    const areas = s.areas as Record<string, unknown> | undefined;
    if (!areas || typeof areas !== 'object' || Object.keys(areas).length === 0) {
      ctx.fail(RenderCodes.INVALID_SPEC_SHAPE, 'spec.areas must be a non-empty object.');
      return;
    }
    const allowed = new Set<string>(RENDER_COMPONENTS as readonly string[]);
    for (const [name, area] of Object.entries(areas)) {
      const comp = (area as { component?: unknown }).component;
      if (typeof comp !== 'string' || !allowed.has(comp)) {
        ctx.fail(
          RenderCodes.UNKNOWN_COMPONENT,
          `area '${name}' uses component '${String(comp)}'. Allowed: ${RENDER_COMPONENTS.join(', ')}.`,
        );
        return;
      }
    }
  },
  execute: async (args) => {
    const spec = JSON.parse(args.spec_json) as Record<string, unknown>;
    if (args.title != null && args.title.trim() !== '') {
      spec.title = args.title;
    }
    return { result: spec };
  },
});

import { defineProc, t } from '@snowflake/synapse';
import { MapRenderCodes, MAP_LAYER_TYPES, MAX_MAP_LAYERS } from '../codes.js';

// render_map: the agent emits a declarative MAP spec (the same LayerSpec[] DSL
// the SA app's authored map areas use) and this verb validates + echoes it back.
// The SA chat client picks the result up and draws it INLINE in the answer, next
// to the prose that explains it - unlike render_view, which takes over the whole
// right-hand panel and replaces the dashboard the user was reading.
//
// Like render_view this verb touches NO data: each layer's query runs later
// through /api/query with dynamic:true, i.e. as the owner's-rights
// FLEET_APP_DYNAMIC_READER behind the FLEET_APP/SNOWFLAKE allowlist (see
// role_binding.sql). The value here is the audited envelope (VERB_ATTEMPT
// records prompt -> spec) plus an early, typed failure the agent can correct
// in-turn rather than a silently blank map. roles:['user'] -> materializes onto
// ROUTING_MCP, the only server attached to the consumer agent.
//
// Note this is an SA-app capability only. CoWork draws maps with the
// host-injected `data_to_map`, which accepts ONE layer and only a SQL/analyst
// tool result - an MCP result like this one is rejected there.
export const render_map = defineProc({
  name: 'render_map',
  description:
    'Draw a map inline in the chat answer from a declarative spec. Use for "map/plot/show me on a map ..." ' +
    'when no saved view already answers it. The spec is a JSON object with `layers` (1-' + MAX_MAP_LAYERS + ') ' +
    'and optional {title, height, legend, emptyMessage}. Each layer is ' +
    '{type, data:{query,params}, ...encoding}, where type is one of: ' + MAP_LAYER_TYPES.join(', ') + '. ' +
    'Layer queries MUST read the neutral FLEET_APP contract, e.g. ' +
    'TABLE(FLEET_APP.CORE.F_FACT_*_SCOPED(CAST(:region AS VARCHAR), CAST(:dataset_id AS VARCHAR))) ' +
    'or FLEET_APP.<DWELL|CATCHMENT|ROUTE_OPTIMIZATION|ROUTE_DEVIATION>.VW_*, and may bind only ' +
    'context.* params (region, vehicle_type, dataset_id, date_range_start, date_range_end) or literals. ' +
    'Project geometry as ST_ASGEOJSON(ST_SIMPLIFY(<geog>, 250))::STRING and filter to a region or band first: ' +
    'an oversized payload renders a BLANK map with no error. ' +
    'Fails with INVALID_MAP_SPEC_JSON, INVALID_MAP_SPEC_SHAPE, or UNKNOWN_LAYER_TYPE. ' +
    'Prefer an existing saved view (a view: link) when one matches, render_view when the map needs ' +
    'surrounding KPIs and tables on a page, and deep_link when the user needs toggles or click-through.',
  roles: ['user'],
  args: {
    spec_json: t
      .string({ min: 2, max: 60000 })
      .describe(
        'The map spec as a JSON object string: {title?, height?, layers:[{type, data:{query,params?}, ' +
        'lng?, lat?, geojsonColumn?, hexColumn?, source?, target?, fillColor?, color?, tooltip?}], ' +
        'legend?:[{label,color,shape?}], emptyMessage?}.',
      ),
    title: t
      .string({ max: 200 })
      .nullable()
      .describe('Optional human title rendered above the map; falls back to the spec title.'),
  },
  returns: {
    result: t
      .object({})
      .describe('The validated map spec (echoed) for the chat client to draw inline.'),
  },
  validate: async (args, ctx) => {
    let spec: unknown;
    try {
      spec = JSON.parse(args.spec_json);
    } catch (e) {
      ctx.fail(MapRenderCodes.INVALID_MAP_SPEC_JSON, `spec_json is not valid JSON: ${(e as Error).message}`);
      return;
    }
    if (typeof spec !== 'object' || spec === null || Array.isArray(spec)) {
      ctx.fail(MapRenderCodes.INVALID_MAP_SPEC_JSON, 'spec_json must be a JSON object.');
      return;
    }
    // Tolerate the area-shaped form an agent may reach for after learning
    // render_view: {config:{layers:[...]}}. The client accepts it too.
    const s = spec as Record<string, unknown>;
    const cfg = s.config;
    const body = (typeof cfg === 'object' && cfg !== null && !Array.isArray(cfg))
      ? (cfg as Record<string, unknown>)
      : s;

    const layers = body.layers;
    if (!Array.isArray(layers) || layers.length === 0) {
      ctx.fail(MapRenderCodes.INVALID_MAP_SPEC_SHAPE, 'spec.layers must be a non-empty array.');
      return;
    }
    if (layers.length > MAX_MAP_LAYERS) {
      ctx.fail(
        MapRenderCodes.INVALID_MAP_SPEC_SHAPE,
        `spec.layers has ${layers.length} layers; at most ${MAX_MAP_LAYERS} are allowed. ` +
        'Draw the most informative layers, or UNION into one layer with a category column.',
      );
      return;
    }
    const allowed = new Set<string>(MAP_LAYER_TYPES as readonly string[]);
    for (let i = 0; i < layers.length; i++) {
      const layer = layers[i] as Record<string, unknown> | null;
      if (typeof layer !== 'object' || layer === null || Array.isArray(layer)) {
        ctx.fail(MapRenderCodes.INVALID_MAP_SPEC_SHAPE, `layer ${i} must be an object.`);
        return;
      }
      const type = layer.type;
      if (typeof type !== 'string' || !allowed.has(type)) {
        ctx.fail(
          MapRenderCodes.UNKNOWN_LAYER_TYPE,
          `layer ${i} uses type '${String(type)}'. Allowed: ${MAP_LAYER_TYPES.join(', ')}.`,
        );
        return;
      }
      const data = layer.data as Record<string, unknown> | undefined;
      const query = data == null ? undefined : data.query;
      if (typeof query !== 'string' || query.trim() === '') {
        ctx.fail(MapRenderCodes.INVALID_MAP_SPEC_SHAPE, `layer ${i} requires data.query.`);
        return;
      }
      const head = query.trim().toUpperCase();
      if (!(head.indexOf('SELECT') === 0 || head.indexOf('WITH') === 0)) {
        ctx.fail(
          MapRenderCodes.INVALID_MAP_SPEC_SHAPE,
          `layer ${i} data.query must be a SELECT/WITH statement.`,
        );
        return;
      }
      // An inline map has no panel viewState, so a viewState.* param would bind
      // to NULL and return zero rows - a blank map with no error. Reject it here
      // rather than letting the client discover it.
      const params = data == null ? undefined : data.params;
      if (typeof params === 'object' && params !== null && !Array.isArray(params)) {
        const entries = Object.entries(params as Record<string, unknown>);
        for (const [name, ref] of entries) {
          if (typeof ref === 'string' && ref.indexOf('viewState.') === 0) {
            ctx.fail(
              MapRenderCodes.INVALID_MAP_SPEC_SHAPE,
              `layer ${i} data.params.${name} binds '${ref}'. An inline map has no view state - ` +
              'bind a context.* param (region, vehicle_type, dataset_id, date_range_start, date_range_end) or a literal.',
            );
            return;
          }
        }
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

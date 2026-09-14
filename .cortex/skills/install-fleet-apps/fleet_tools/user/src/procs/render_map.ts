import { defineProc, t } from '@snowflake/synapse';
import { MapRenderCodes, MAP_LAYER_TYPES, MAX_MAP_LAYERS, ALLOWED_DYNAMIC_DBS } from '../codes.js';

// Any 3-part qualified name (DB.SCHEMA.OBJECT), covering both
// `FROM/JOIN db.schema.obj` and `TABLE(db.schema.fn(...))`. Same expression
// /api/query uses, so the two boundaries agree on what a database reference is.
const QUALIFIED_NAME_RE =
  /\b([A-Za-z_][A-Za-z0-9_$]*)\s*\.\s*[A-Za-z_][A-Za-z0-9_$]*\s*\.\s*[A-Za-z_][A-Za-z0-9_$]*/g;

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
    'Layer queries may read ONLY: ' + ALLOWED_DYNAMIC_DBS.join(', ') + '. Normally the neutral ' +
    'FLEET_APP contract, e.g. TABLE(FLEET_APP.CORE.F_FACT_*_SCOPED(CAST(:region AS VARCHAR), ' +
    'CAST(:dataset_id AS VARCHAR))) or FLEET_APP.<DWELL|CATCHMENT|ROUTE_OPTIMIZATION|ROUTE_DEVIATION>.VW_*; ' +
    'for LIVE geometry a layer may call TABLE(ROUTING_PLATFORM.CONTRACT.DIRECTIONS|ISOCHRONES|OPTIMIZATION(...)) ' +
    'projecting ST_ASGEOJSON(GEOJSON)::STRING. Params may bind only ' +
    'context.* params (region, vehicle_type, dataset_id, date_range_start, date_range_end) or literals. ' +
    'Use the REAL column names - for an H3 dwell/congestion density map that is ' +
    'FLEET_APP.DWELL.VW_DWELL_SESSIONS with H3_CELL_R7 (the hex), DWELL_MINUTES (the measure) ' +
    'and REGION (the filter); there is no h3_cell, dwell_duration_minutes or region_key column. ' +
    'Project geometry as ST_ASGEOJSON(ST_SIMPLIFY(<geog>, 250))::STRING, filtered to a region or band: ' +
    'an oversized payload renders a BLANK map with no error. ' +
    'Fails with INVALID_MAP_SPEC_JSON, INVALID_MAP_SPEC_SHAPE, UNKNOWN_LAYER_TYPE, INVALID_MAP_SPEC_DB ' +
    '(a layer query naming any other database), or ' +
    'INVALID_MAP_SPEC_SQL (a layer query that does not compile - fix the column names and retry). ' +
    'Do NOT redraw geometry a routing tool returned (get_directions, compute_isochrone, ' +
    'optimize_routes, find_poi, catchment): those draw their own result inline, so this would ' +
    'produce TWO maps of one answer. ' +
    'Do NOT author a `legend`: the client DERIVES it from the colours each layer actually draws ' +
    '(a continuous gradient with the real min/max for a valueColumn layer, one swatch per palette ' +
    'entry otherwise), so a hand-written key would contradict the map. Set `legendLabel` on a layer ' +
    'to name it, and a `tooltip` template like "<b>{H3_CELL_R7}</b><br/>{DWELL_MINUTES} min" to say ' +
    'what a hover shows - hovering is enabled for you, and a layer with no template gets one ' +
    'synthesized from its columns. ' +
    'Prefer an existing saved view (a view: link) when one matches, render_view when the map needs ' +
    'surrounding KPIs and tables on a page, and deep_link when the user needs toggles or click-through.',
  roles: ['user'],
  args: {
    spec_json: t
      .string({ min: 2, max: 60000 })
      .describe(
        'The map spec as a JSON object string: {title?, height?, layers:[{type, data:{query,params?}, ' +
        'lng?, lat?, geojsonColumn?, hexColumn?, valueColumn?, colorScale?, source?, target?, ' +
        'fillColor?, color?, tooltip?, legendLabel?}], emptyMessage?}. The legend is derived by the ' +
        'client from the layer encodings - do not author one.',
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
      // Databases the dynamic read boundary allows. Checked HERE and not left to
      // the EXPLAIN gate below, which cannot see this class of error at all: this
      // proc runs EXECUTE AS OWNER, so a refused database raises "does not exist
      // or not authorized" and that gate deliberately ignores it. An allowlist is
      // a string comparison, so it convicts without inferring privileges.
      QUALIFIED_NAME_RE.lastIndex = 0;
      let qm: RegExpExecArray | null;
      while ((qm = QUALIFIED_NAME_RE.exec(query)) !== null) {
        const raw = qm[1] ?? '';
        const db = raw.toUpperCase();
        if (ALLOWED_DYNAMIC_DBS.indexOf(db as (typeof ALLOWED_DYNAMIC_DBS)[number]) === -1) {
          ctx.fail(
            MapRenderCodes.INVALID_MAP_SPEC_DB,
            `layer ${i} data.query reads database '${raw}', which the dynamic read boundary refuses. ` +
              `Allowed: ${ALLOWED_DYNAMIC_DBS.join(', ')}. Read the neutral FLEET_APP contract ` +
              '(FLEET_APP.CORE.F_FACT_*_SCOPED, FLEET_APP.<DWELL|CATCHMENT|ROUTE_OPTIMIZATION>.VW_*), ' +
              'or ROUTING_PLATFORM.CONTRACT.DIRECTIONS/ISOCHRONES/OPTIMIZATION for live geometry - ' +
              'never SYNTHETIC_DATASETS, OPENROUTESERVICE_APP or FLEET_INTELLIGENCE.',
          );
          return;
        }
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

    // ---- compile each layer query -------------------------------------------
    // The checks above validate SHAPE only, which is how a spec naming
    // `h3_cell` / `dwell_duration_minutes` / `region_key` on
    // FLEET_APP.DWELL.VW_DWELL_SESSIONS (really H3_CELL_R7 / DWELL_MINUTES /
    // REGION) passed validation, echoed cleanly, and then died in the browser as
    // "Some layers could not be drawn". EXPLAIN compiles the statement without
    // reading a row, so the verb keeps its no-data property and the agent gets a
    // typed failure it can correct in the same turn.
    //
    // DELIBERATELY NARROW: only an unknown column or a syntax error convicts.
    // This proc runs EXECUTE AS OWNER, so an object the owner cannot see raises
    // "does not exist or not authorized" - a message that cannot distinguish a
    // wrong view name from a missing grant. Failing on it would reject VALID
    // specs whenever grants drift, which is worse than the gap it closes. Object
    // resolution stays with the runtime path, which runs as the reader role that
    // actually matters (FLEET_APP_DYNAMIC_READER).
    for (let i = 0; i < layers.length; i++) {
      const layer = layers[i] as Record<string, unknown>;
      const data = layer.data as Record<string, unknown>;
      const query = data.query as string;
      // Params are bound by the client at render time; here they only need to
      // TYPE-CHECK, so each :name becomes an untyped NULL. Longest name first so
      // `:region` cannot partially consume `:region_key`.
      const names = Object.keys(
        (typeof data.params === 'object' && data.params !== null && !Array.isArray(data.params)
          ? data.params
          : {}) as Record<string, unknown>,
      ).sort((a, b) => b.length - a.length);
      let probe = query;
      for (const n of names) probe = probe.split(':' + n).join('NULL');
      // Any remaining :name (a param the spec forgot to declare) would be an
      // unbound bind at runtime; neutralize it so the compile error we report is
      // about the agent's columns, not about our own probe.
      probe = probe.replace(/:[A-Za-z_][A-Za-z0-9_]*/g, 'NULL');
      try {
        await ctx.conn.exec('EXPLAIN USING TEXT ' + probe);
      } catch (e) {
        const msg = (e as Error).message || String(e);
        if (/invalid identifier|syntax error|unexpected/i.test(msg)) {
          ctx.fail(
            MapRenderCodes.INVALID_MAP_SPEC_SQL,
            `layer ${i} data.query does not compile: ${msg} ` +
              'Check the column names against the view you are querying - ' +
              'FLEET_APP.DWELL.VW_DWELL_SESSIONS exposes H3_CELL_R7, DWELL_MINUTES, ' +
              'DWELL_SECONDS, REGION, VEHICLE_TYPE, CITY, FACILITY_TYPE, LOCATION_NAME, ' +
              'AVG_POINT (not h3_cell, dwell_duration_minutes or region_key). ' +
              'Describe the view first if you are unsure.',
          );
          return;
        }
        // Anything else (privileges, warehouse, transient) is not the agent's
        // error to fix: let the render path surface it in context.
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

import { defineProc, t } from '@snowflake/synapse';
import { Procs } from '../catalog.js';
import { callTool } from '../helpers.js';

// Region-generic Emergency Response participant seeder. Wraps TOOL_EVAC_SEED:
// builds the drive-time isochrone union over the active region's health-anchor
// care centers, samples routable Overture addresses inside it, and tags each
// with the county FEMA risk for the chosen hazard. The wizard calls this for
// Step 2 (seed participants); the agent can call it for "who is at risk near X".
export const evac_seed = defineProc({
  name: 'evac_seed',
  description:
    'Seed evacuation participants for the active region: union the drive-time ' +
    'isochrones of the region health/care centers, sample routable people inside, ' +
    'and tag each with county flood/wildfire risk. Returns the coverage polygon ' +
    'and participant points. Use for "seed evacuees" / "who needs evacuation near the centers".',
  roles: ['user'],
  args: {
    region: t
      .string({ max: 80 })
      .nullable()
      .describe('Region whose care centers + road graph to use. Defaults to the active region when null.'),
    hazard_type: t
      .string({ max: 20 })
      .nullable()
      .describe('WILDFIRE, FLOOD, or COMPOSITE — which FEMA risk to tag participants with. Defaults to WILDFIRE.'),
    range_minutes: t
      .number()
      .nullable()
      .describe('Drive-time isochrone radius in minutes around each care center (1-60). Defaults to 15.'),
    target_count: t
      .number()
      .nullable()
      .describe('How many participants to sample (1-500). Defaults to 60.'),
  },
  returns: {
    result: t.object({}).describe('Seed response: union_geojson coverage polygon + risk-tagged participants[].'),
  },
  execute: async (args, ctx) => {
    const result = await callTool(ctx.conn, Procs.evacSeed, [
      args.region,
      args.hazard_type,
      args.range_minutes,
      args.target_count,
    ]);
    return { result };
  },
});

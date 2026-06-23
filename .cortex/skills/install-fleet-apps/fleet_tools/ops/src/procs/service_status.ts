import { defineProc, t } from '@snowflake/synapse';

export const service_status = defineProc({
  name: 'service_status',
  description:
    'Get the live status of an SPCS service as reported by Snowflake ' +
    '(SYSTEM$GET_SERVICE_STATUS). Provide the fully-qualified service name. Ops-only.',
  roles: ['ops'],
  args: {
    service: t
      .string({ min: 1, max: 200 })
      .describe('Fully-qualified service name, e.g. OPENROUTESERVICE_APP.CORE.ROUTING_GATEWAY_SERVICE.'),
  },
  returns: {
    service: t.string().describe('The service queried.'),
    status_json: t.string().describe('Raw SYSTEM$GET_SERVICE_STATUS JSON.'),
  },
  execute: async (args, ctx) => {
    const out = await ctx.conn.execScalar<string>('SELECT SYSTEM$GET_SERVICE_STATUS(?)', [args.service]);
    return { service: args.service, status_json: out == null ? '[]' : String(out) };
  },
});

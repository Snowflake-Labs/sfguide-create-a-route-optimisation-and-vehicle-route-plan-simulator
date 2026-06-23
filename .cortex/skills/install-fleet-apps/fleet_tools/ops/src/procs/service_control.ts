import { defineProc, t } from '@snowflake/synapse';

// Allowed object-name shape: 1-3 dotted identifiers, word chars only. Service
// names cannot be bound as parameters in ALTER SERVICE, so the name is validated
// against this strict pattern before interpolation (injection-safe).
const NAME_RE = /^[A-Za-z0-9_]+(\.[A-Za-z0-9_]+){0,2}$/;

export const service_control = defineProc({
  name: 'service_control',
  description:
    'Suspend or resume an SPCS service (e.g. a regional ORS/VROOM routing service or ' +
    'the Fleet SA app). Provide the fully-qualified service name. Ops-only.',
  roles: ['ops'],
  args: {
    service: t
      .string({ min: 1, max: 200 })
      .describe('Fully-qualified service name, e.g. OPENROUTESERVICE_APP.CORE.ORS_SERVICE_EUROPE.'),
    action: t.string({ min: 1, max: 16 }).describe('SUSPEND or RESUME.'),
  },
  returns: {
    ok: t.boolean().describe('True when the action was applied.'),
    service: t.string().describe('The service acted on.'),
    action: t.string().describe('The normalized action applied.'),
    message: t.string().describe('Status message from Snowflake.'),
  },
  execute: async (args, ctx) => {
    const service = args.service.trim();
    const action = args.action.trim().toUpperCase();
    if (!NAME_RE.test(service)) {
      throw new Error(`Invalid service name: ${args.service}`);
    }
    if (action !== 'SUSPEND' && action !== 'RESUME') {
      throw new Error(`Invalid action: ${args.action} (expected SUSPEND or RESUME)`);
    }
    const out = await ctx.conn.execScalar<string>(`ALTER SERVICE IF EXISTS ${service} ${action}`);
    return {
      ok: true,
      service,
      action,
      message: out == null ? `${action} applied to ${service}` : String(out),
    };
  },
});

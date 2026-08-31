import { defineProc, t } from '@snowflake/synapse';
import { OpsCodes } from '../codes.js';

/**
 * Cost levers: the idle/spend controls that previously existed only as buttons
 * in the admin app UI.
 *
 * One verb rather than four, because the four are one decision ("how much is
 * this environment allowed to cost right now") and an agent choosing between
 * four similarly-named tools reliably picks the wrong one. `action` makes the
 * choice explicit and auditable in a single VERB_ATTEMPT row.
 *
 * `status` is the default and is read-only. Everything else spends or stops
 * spending money, so the agent instructions require naming the effect and
 * getting agreement first - cost_safe_mode in particular suspends running
 * services, which will interrupt anyone mid-demo.
 */

const ACTIONS = ['status', 'cost_safe_mode', 'resume_fleet', 'set_hibernate', 'scale'] as const;

export const cost_control = defineProc({
  name: 'cost_control',
  description:
    'Read or change how much compute this deployment is allowed to consume. actions: "status" ' +
    '(read-only; current hibernate and keep-warm settings), "cost_safe_mode" (suspend everything ' +
    'suspendable to stop spend NOW - this WILL interrupt anyone using the app, so confirm first), ' +
    '"resume_fleet" (bring the fleet services back up), "set_hibernate" (turn auto-hibernate on ' +
    'or off and set the idle hours), "scale" (set routing, gateway and pool instance counts). ' +
    'Use "status" freely; for every other action state the effect and get explicit user ' +
    'agreement before calling. A service reading SUSPENDED afterwards is the intended outcome, ' +
    'not a fault.',
  roles: ['ops'],
  args: {
    action: t
      .string({ min: 1, max: 20 })
      .describe(`One of: ${ACTIONS.join(', ')}. Use "status" to read without changing anything.`),
    enabled: t
      .boolean()
      .nullable()
      .describe('For set_hibernate: whether auto-hibernate is on.'),
    idle_hours: t
      .number()
      .nullable()
      .describe('For set_hibernate: idle hours before hibernating (1-72).'),
    ors_instances: t.number().nullable().describe('For scale: routing service instances.'),
    gateway_instances: t.number().nullable().describe('For scale: gateway instances.'),
    pool_nodes: t.number().nullable().describe('For scale: compute pool nodes.'),
  },
  returns: {
    action: t.string().describe('The action performed.'),
    result: t.object({}).describe('Settings read, or the outcome message of the change.'),
  },
  validate: async (args, ctx) => {
    const action = (args.action ?? '').trim().toLowerCase();
    if (!ACTIONS.includes(action as (typeof ACTIONS)[number])) {
      ctx.fail(
        OpsCodes.INVALID_SCALE,
        `action must be one of ${ACTIONS.join(', ')} (got "${args.action}")`,
      );
      return;
    }

    if (action === 'set_hibernate') {
      if (args.enabled == null && args.idle_hours == null) {
        ctx.fail(
          OpsCodes.INVALID_IDLE_HOURS,
          'set_hibernate needs at least one of enabled or idle_hours. Use action="status" to read.',
        );
        return;
      }
      if (args.idle_hours != null) {
        const h = Number(args.idle_hours);
        if (!Number.isFinite(h) || h < 1 || h > 72 || Math.floor(h) !== h) {
          ctx.fail(OpsCodes.INVALID_IDLE_HOURS, 'idle_hours must be a whole number from 1 to 72');
        }
      }
    }

    if (action === 'scale') {
      const trio = [args.ors_instances, args.gateway_instances, args.pool_nodes];
      if (trio.some((v) => v == null)) {
        ctx.fail(
          OpsCodes.INVALID_SCALE,
          'scale needs all three of ors_instances, gateway_instances and pool_nodes: the ' +
            'underlying procedure sets them together, so a partial call would silently reset the ' +
            'others.',
        );
        return;
      }
      for (const v of trio) {
        const n = Number(v);
        if (!Number.isFinite(n) || n < 0 || Math.floor(n) !== n) {
          ctx.fail(OpsCodes.INVALID_SCALE, 'instance and node counts must be whole numbers >= 0');
          return;
        }
      }
    }
  },
  execute: async (args, ctx) => {
    const action = (args.action ?? '').trim().toLowerCase();

    const readSettings = async (): Promise<Record<string, unknown>> => {
      try {
        const row = await ctx.conn.execRow<Record<string, unknown>>(
          `SELECT HIBERNATE_ENABLED, HIBERNATE_IDLE_HOURS, KEEPWARM_IDLE_MINUTES,
                  TO_VARCHAR(UPDATED_AT) AS UPDATED_AT
             FROM FLEET_INTELLIGENCE.CORE.COST_SETTINGS
            WHERE SETTING_KEY = 'GLOBAL' LIMIT 1`,
        );
        return {
          hibernate_enabled: row?.HIBERNATE_ENABLED ?? null,
          hibernate_idle_hours: row?.HIBERNATE_IDLE_HOURS ?? null,
          keepwarm_idle_minutes: row?.KEEPWARM_IDLE_MINUTES ?? null,
          updated_at: row?.UPDATED_AT ?? null,
        };
      } catch (e) {
        return { error: (e as Error).message };
      }
    };

    if (action === 'status') {
      const settings = await readSettings();
      return {
        action,
        result: {
          settings,
          note:
            'AUTO_SUSPEND_SECS=0 on a RUNNING service is an expected steady state, not drift: it ' +
            'means an active build or the keep-warm window is deliberately pinning it. ' +
            'keepwarm_idle_minutes is the window during which a region with real routing traffic ' +
            'is protected from the blind SPCS idle timer.',
        },
      };
    }

    if (action === 'cost_safe_mode') {
      const out = await ctx.conn.execScalar<string>('CALL OPENROUTESERVICE_APP.CORE.COST_SAFE_MODE()');
      return {
        action,
        result: {
          message: out == null ? 'cost safe mode applied' : String(out),
          note: 'Services are now suspended. The next routing call will resume the region it needs, which is not instant for a large region.',
        },
      };
    }

    if (action === 'resume_fleet') {
      const out = await ctx.conn.execScalar<string>('CALL OPENROUTESERVICE_APP.CORE.RESUME_FLEET()');
      return {
        action,
        result: {
          message: out == null ? 'fleet resume requested' : String(out),
          note: 'A resumed region still has to load its road graph before routing answers, so allow time before opening a routing view.',
        },
      };
    }

    if (action === 'set_hibernate') {
      const current = await readSettings();
      const enabled =
        args.enabled != null ? args.enabled : Boolean(current.hibernate_enabled ?? true);
      const hours =
        args.idle_hours != null
          ? Math.floor(Number(args.idle_hours))
          : Number(current.hibernate_idle_hours ?? 4);

      await ctx.conn.exec(
        `MERGE INTO FLEET_INTELLIGENCE.CORE.COST_SETTINGS t
         USING (SELECT 'GLOBAL' AS SETTING_KEY) s ON t.SETTING_KEY = s.SETTING_KEY
         WHEN MATCHED THEN UPDATE SET HIBERNATE_ENABLED = ?, HIBERNATE_IDLE_HOURS = ?,
                                     UPDATED_AT = CURRENT_TIMESTAMP()
         WHEN NOT MATCHED THEN INSERT (SETTING_KEY, HIBERNATE_ENABLED, HIBERNATE_IDLE_HOURS)
                               VALUES ('GLOBAL', ?, ?)`,
        [enabled, hours, enabled, hours],
      );
      return {
        action,
        result: {
          settings: await readSettings(),
          message: `auto-hibernate ${enabled ? 'enabled' : 'disabled'} at ${hours}h idle`,
        },
      };
    }

    // scale
    const out = await ctx.conn.execScalar<string>(
      'CALL OPENROUTESERVICE_APP.CORE.SCALE_SERVICES(?, ?, ?)',
      [
        Math.floor(Number(args.ors_instances)),
        Math.floor(Number(args.gateway_instances)),
        Math.floor(Number(args.pool_nodes)),
      ],
    );
    return {
      action,
      result: { message: out == null ? 'scaled' : String(out) },
    };
  },
});

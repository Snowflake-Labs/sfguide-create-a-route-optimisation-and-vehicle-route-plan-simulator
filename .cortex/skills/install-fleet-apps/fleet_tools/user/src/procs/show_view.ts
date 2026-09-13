import { defineProc, t } from '@snowflake/synapse';
import { DataCodes } from '../codes.js';

/**
 * Navigate the SA app's panel to a view, already scoped.
 *
 * WHY THIS EXISTS, AND HOW IT DIFFERS FROM deep_link
 * --------------------------------------------------
 * `deep_link` builds a URL for a user OUTSIDE the app (Cowork / Snowflake
 * Intelligence): the user clicks it, the app cold-boots, and `applyDeepLink`
 * applies the params. That is the only honest option there, because there is no
 * running app to drive.
 *
 * Inside the app the agent already has a live panel next to it, and until now it
 * could only ask the user to click: the chat client turns a `[label](view:id)`
 * markdown link into a button. That works, but it makes every visual answer a
 * two-step, and it cannot carry a result the agent just computed.
 *
 * This verb closes that gap. The SA chat store watches for a `show_view` tool
 * result and applies it directly, so the panel moves as part of the answer. The
 * consumer was already written and waiting - what was missing was any producer.
 *
 * IT DOES NOTHING OUTSIDE THE APP
 * There is no way for a stored procedure to reach a browser, so in Cowork /
 * Snowflake Intelligence this verb cannot navigate anything: the tool result is
 * simply displayed. That is why `note` says so explicitly and why the
 * description tells the agent to use `deep_link` there instead. An agent that
 * calls this outside the app produces no visible effect at all, which is the
 * worst kind of failure - it looks like it worked.
 *
 * THE PARAMS ARE THE DEEP-LINK VOCABULARY, DELIBERATELY
 * The returned `params` use the same names `deep_link` puts in its URL, so the
 * app resolves both transports through one module (`lib/view-params.ts`) and the
 * two paths cannot drift apart. In particular `region` must NOT be returned as a
 * selection: region lives in the store's `context`, and a view like Backload
 * Matching reads `context['region']` and never looks at viewState, so a region
 * in the wrong bucket renders a perfectly correct page for the wrong continent.
 */

export const show_view = defineProc({
  name: 'show_view',
  description:
    'Open a dashboard view in the Fleet app panel, scoped to a region, asset mode and/or ' +
    'selection, when you are running INSIDE the app (the left-hand chat panel). The panel ' +
    'navigates immediately, so use this instead of asking the user to click a view link. ' +
    'Pair it with an answer: state the figures, then open the view so the user can see the ' +
    'map. To carry a result you just computed, pass it in selection as key=value - e.g. ' +
    'selection="solve_key=<the solve_key returned by backload_solve>" opens Backload Matching ' +
    'showing that exact plan instead of re-solving it. This verb has NO effect in Snowflake ' +
    'Intelligence or Cowork, where there is no app panel to move: use deep_link there and give ' +
    'the user a URL. The view id must be one from the solution catalog ' +
    '(search_solution_catalog or list_use_cases).',
  roles: ['user'],
  args: {
    view_id: t
      .string({ min: 1, max: 120 })
      .describe('View to open, e.g. "backload_matching" or "catchment". Must exist in the catalog.'),
    region: t
      .string({ max: 80 })
      .nullable()
      .describe('Optional region to apply, e.g. "UnitedStatesOfAmerica". Applied as context.'),
    vehicle_type: t
      .string({ max: 80 })
      .nullable()
      .describe('Optional asset mode to apply (e.g. car, hgv, ebike). Applied as context.'),
    dataset_id: t.string({ max: 200 }).nullable().describe('Optional dataset id to apply.'),
    selection: t
      .string({ max: 300 })
      .nullable()
      .describe(
        'Optional state to apply on open. Either "key=value" pairs separated by commas, or a ' +
          'bare value when the view has a single selectable entity. Use "solve_key=..." to show ' +
          'an already-solved plan rather than making the page solve again.',
      ),
  },
  returns: {
    viewId: t.string().describe('The validated view id the app will open.'),
    params: t
      .object({})
      .describe('Scoping params in deep-link vocabulary (view/region/vehicle/dataset/select).'),
    label: t.string().describe('The view label, for referring to it in the answer.'),
    note: t.string().describe('Caveat to pass on to the user, if any.'),
  },
  validate: async (args, ctx) => {
    const id = (args.view_id ?? '').trim();
    // Same shape guard as deep_link: the id is echoed to a client that uses it to
    // index a view registry, so knowing it is a bare id is not something a
    // catalog lookup can substitute for.
    if (!/^[A-Za-z0-9_-]+$/.test(id)) {
      ctx.fail(
        DataCodes.INVALID_OBJECT_NAME,
        'view_id must contain only letters, digits, underscores and hyphens',
      );
      return;
    }
    let n = 0;
    try {
      n = Number(
        (await ctx.conn.execScalar<number>(
          `SELECT COUNT(*) FROM FLEET_INTELLIGENCE.SEMANTIC.VIEW_CATALOG WHERE VIEW_ID = ?`,
          [id],
        )) ?? 0,
      );
    } catch {
      // No catalog (not yet generated): fall through rather than blocking
      // navigation. The client ignores an unregistered id and keeps the context,
      // which is a better outcome than refusing because a table is missing.
      return;
    }
    if (n === 0) {
      ctx.fail(
        DataCodes.UNKNOWN_VIEW_ID,
        `"${id}" is not a view in this deployment. Use search_solution_catalog or ` +
          'list_use_cases to find the right view id.',
      );
    }
  },
  execute: async (args, ctx) => {
    const viewId = args.view_id.trim();

    let label = viewId;
    try {
      const got = await ctx.conn.execScalar<string>(
        `SELECT LABEL FROM FLEET_INTELLIGENCE.SEMANTIC.VIEW_CATALOG WHERE VIEW_ID = ? LIMIT 1`,
        [viewId],
      );
      if (got) label = String(got);
    } catch {
      // Keep the id as the label.
    }

    // Plain object assembly only. This runs as a LANGUAGE JAVASCRIPT procedure,
    // which has no URL, URLSearchParams, fetch or Buffer - `deep_link` shipped
    // broken for exactly that reason, and check_verb_js_globals.py now fails the
    // commit on it. Nothing here needs a host API: the client does the encoding.
    const params: Record<string, string> = { view: viewId };
    const add = (key: string, value: string | null): void => {
      const v = (value ?? '').trim();
      if (v !== '') params[key] = v;
    };
    add('region', args.region);
    add('vehicle', args.vehicle_type);
    add('dataset', args.dataset_id);
    add('select', args.selection);

    return {
      viewId,
      params,
      label,
      note:
        'The app panel opens this view with the given scope applied. If the user is in Snowflake ' +
        'Intelligence or Cowork rather than the app, nothing will move on screen - give them a ' +
        'deep_link URL instead. A routing view also needs that region\'s services running.',
    };
  },
});

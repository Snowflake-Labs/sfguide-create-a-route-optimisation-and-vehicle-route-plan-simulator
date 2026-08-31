import { viewRegistry } from './view-registry';

/**
 * Deep-link bootstrap: apply URL search params to the store on first load.
 *
 * WHY THIS EXISTS
 * ---------------
 * The SA app had no URL parameter handling at all (a grep for `searchParams`
 * across ui/src returned nothing), so there was no way to reference a specific
 * view, region or selection from outside the app. That made the agent unable to
 * do the one thing it can honestly do about maps when it is running in Cowork /
 * Snowflake Intelligence, where there is no deck.gl canvas to draw on: answer
 * with the numbers and hand over a link that opens the real map, already scoped.
 *
 * WHAT IT ACCEPTS
 *   view      - a registered view id (e.g. delivery_sync)
 *   region    - context.region
 *   vehicle   - context.vehicle_type
 *   dataset   - context.dataset_id
 *   as_of     - context.as_of_minute (playback clocks)
 *   from / to - context.date_range_start / date_range_end
 *   select    - a viewState patch, either `key=value` pairs (comma-separated) or
 *               a bare value which is applied to the view's declared selection
 *               key when it has exactly one obvious candidate
 *
 * ORDERING IS LOAD-BEARING
 * Must run AFTER view registration (or `view` resolves to nothing and the deep
 * link silently opens the default page) and AFTER the contextBar defaults are
 * seeded (or the defaults overwrite the link's values). Both are satisfied by
 * calling it at the end of the shell's config effect, right after
 * bumpViewsVersion().
 *
 * IDEMPOTENT AND SILENT ON FAILURE
 * A bad view id is ignored rather than thrown: a stale link should open the app,
 * not break it. The params are consumed once - the URL is rewritten with
 * history.replaceState afterwards - so a later re-render or a user navigating
 * away does not snap them back to the linked view.
 */

// Search param -> context key. Only these are accepted; anything else is
// ignored, so a link cannot set arbitrary context.
const CONTEXT_PARAMS: Record<string, string> = {
  region: 'region',
  vehicle: 'vehicle_type',
  vehicle_type: 'vehicle_type',
  dataset: 'dataset_id',
  dataset_id: 'dataset_id',
  as_of: 'as_of_minute',
  from: 'date_range_start',
  to: 'date_range_end',
};

export interface DeepLinkResult {
  applied: boolean;
  viewId: string | null;
  context: Record<string, string>;
  viewState: Record<string, string>;
}

/** Parse `select` into a viewState patch. Supports `k=v,k2=v2` or a bare value. */
function parseSelect(raw: string, viewId: string | null): Record<string, string> {
  const out: Record<string, string> = {};
  if (raw.includes('=')) {
    for (const pair of raw.split(',')) {
      const eq = pair.indexOf('=');
      if (eq <= 0) continue;
      const k = pair.slice(0, eq).trim();
      const v = pair.slice(eq + 1).trim();
      if (k && v) out[k] = v;
    }
    return out;
  }

  // Bare value: only usable when the view declares exactly one selection key, so
  // guessing is impossible. A view with several would need explicit k=v.
  const def = viewId ? viewRegistry.get(viewId) : null;
  const emits = (def as { clickEmits?: Record<string, string> } | null)?.clickEmits;
  const keys = emits ? Object.values(emits).filter((v) => typeof v === 'string') : [];
  const unique = Array.from(new Set(keys));
  if (unique.length === 1 && unique[0]) out[unique[0]] = raw.trim();
  return out;
}

/**
 * Read the deep-link params and apply them via the supplied store setters.
 *
 * Takes setters rather than reaching into the store so it stays unit-testable
 * and cannot accidentally subscribe a component to store updates.
 */
export function applyDeepLink(opts: {
  setContext: (key: string, value: unknown) => void;
  showView: (viewId: string, state?: Record<string, unknown>) => void;
}): DeepLinkResult {
  const empty: DeepLinkResult = { applied: false, viewId: null, context: {}, viewState: {} };
  if (typeof window === 'undefined') return empty;

  let params: URLSearchParams;
  try {
    params = new URLSearchParams(window.location.search);
  } catch {
    return empty;
  }
  if (Array.from(params.keys()).length === 0) return empty;

  const context: Record<string, string> = {};
  for (const [param, key] of Object.entries(CONTEXT_PARAMS)) {
    const v = params.get(param);
    if (v != null && v.trim() !== '') context[key] = v.trim();
  }

  // Resolve the view BEFORE applying anything, so an unknown id degrades to a
  // context-only deep link rather than being silently dropped along with it.
  const requested = (params.get('view') ?? '').trim();
  let viewId: string | null = null;
  if (requested !== '') {
    viewId = viewRegistry.get(requested) ? requested : null;
    if (viewId === null) {
      console.warn(`[deep-link] unknown view id "${requested}" - ignoring the view parameter`);
    }
  }

  const selectRaw = (params.get('select') ?? '').trim();
  const viewState = selectRaw !== '' ? parseSelect(selectRaw, viewId) : {};

  // Context first: the view's areas read context on mount, so setting it after
  // showView would make the first fetch run against the wrong region.
  for (const [k, v] of Object.entries(context)) opts.setContext(k, v);
  if (viewId) opts.showView(viewId, viewState);

  const applied = viewId !== null || Object.keys(context).length > 0;

  // Consume the params so a later render or a back/forward does not reapply them
  // and yank the user back to the linked view. replaceState keeps history clean.
  if (applied) {
    try {
      window.history.replaceState({}, '', window.location.pathname);
    } catch {
      // Non-fatal: the params staying in the URL is cosmetic.
    }
  }

  return { applied, viewId, context, viewState };
}

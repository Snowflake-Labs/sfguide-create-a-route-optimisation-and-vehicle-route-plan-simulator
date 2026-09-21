import { resolveViewParams, applyResolvedParams } from './view-params';

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
 * The vocabulary lives in ./view-params, because the in-app `show_view` tool
 * result resolves the SAME names through the same code. See VIEW_PARAM_NAMES.
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

export interface DeepLinkResult {
  applied: boolean;
  viewId: string | null;
  context: Record<string, string>;
  viewState: Record<string, string>;
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

  const resolved = resolveViewParams((p) => params.get(p));
  if (resolved.unknownView) {
    console.warn(
      `[deep-link] unknown view id "${resolved.unknownView}" - ignoring the view parameter`,
    );
  }

  const applied = applyResolvedParams(resolved, opts);

  // Consume the params so a later render or a back/forward does not reapply them
  // and yank the user back to the linked view. replaceState keeps history clean.
  if (applied) {
    try {
      window.history.replaceState({}, '', window.location.pathname);
    } catch {
      // Non-fatal: the params staying in the URL is cosmetic.
    }
  }

  return {
    applied,
    viewId: resolved.viewId,
    context: resolved.context,
    viewState: resolved.viewState,
  };
}

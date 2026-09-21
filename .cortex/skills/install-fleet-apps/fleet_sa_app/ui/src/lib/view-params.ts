import { viewRegistry } from './view-registry';

/**
 * The single vocabulary for "open this view, scoped like this".
 *
 * WHY THIS IS SHARED
 * ------------------
 * Two callers now resolve the same parameters, and they arrive by completely
 * different transports:
 *
 *   1. `applyDeepLink` reads them from `window.location.search` on first load
 *      (the Cowork / Snowflake Intelligence path, where the agent hands over a
 *      URL built by the `deep_link` verb).
 *   2. The chat store reads them from a `show_view` tool result, when the agent
 *      is running INSIDE the app and navigates the panel directly.
 *
 * Those two paths must accept exactly the same names and split them the same
 * way. Keeping two copies of this map is the failure this module exists to
 * prevent: both copies compile, both return rows, and the divergence shows up
 * only as one transport silently ignoring a parameter the other honours - so a
 * link works and the equivalent tool call quietly opens an unscoped page.
 *
 * THE CONTEXT / VIEWSTATE SPLIT IS NOT COSMETIC
 * Region, asset mode and dataset live in the store's `context`; a selection
 * lives in the panel's `viewState`. They are set by different store actions, so
 * a caller that puts `region` into viewState navigates to a page that renders
 * perfectly against the WRONG region. `BackloadMatchingView`, for instance,
 * reads `context['region']` and nothing else, so a region in viewState is not a
 * degraded result - it is invisible.
 */

// Accepted param -> context key. This is an allowlist: anything else is ignored,
// so neither a crafted URL nor an agent tool call can set arbitrary context.
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

/** Every param name this vocabulary understands, for callers that need to echo it. */
export const VIEW_PARAM_NAMES: readonly string[] = [
  'view',
  'select',
  ...Object.keys(CONTEXT_PARAMS),
];

export interface ResolvedViewParams {
  /** A registered view id, or null when absent or unknown. */
  viewId: string | null;
  /** Store context patch, keyed by context key (not by param name). */
  context: Record<string, string>;
  /** Panel viewState patch. */
  viewState: Record<string, string>;
  /** Set when a view was requested but is not registered in this deployment. */
  unknownView: string | null;
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
 * Resolve a set of view parameters, however they were transported.
 *
 * `read` is a lookup by PARAM name (`vehicle`, not `vehicle_type`), so a caller
 * can pass `URLSearchParams.get` or an object accessor unchanged.
 *
 * Resolution order matters: the view is resolved BEFORE the selection, because
 * a bare `select` value can only be interpreted against the target view's
 * `clickEmits`. An unknown view id degrades to a context-only result rather
 * than discarding the context along with it, so a stale link or a slightly
 * wrong tool call still lands the user on the right region.
 */
export function resolveViewParams(
  read: (param: string) => string | null | undefined,
): ResolvedViewParams {
  const context: Record<string, string> = {};
  for (const [param, key] of Object.entries(CONTEXT_PARAMS)) {
    const v = read(param);
    if (v != null && String(v).trim() !== '') context[key] = String(v).trim();
  }

  const requested = String(read('view') ?? '').trim();
  let viewId: string | null = null;
  let unknownView: string | null = null;
  if (requested !== '') {
    if (viewRegistry.get(requested)) {
      viewId = requested;
    } else {
      unknownView = requested;
    }
  }

  const selectRaw = String(read('select') ?? '').trim();
  const viewState = selectRaw !== '' ? parseSelect(selectRaw, viewId) : {};

  return { viewId, context, viewState, unknownView };
}

/**
 * Apply a resolved set of params through the supplied store setters.
 *
 * Context is applied FIRST and unconditionally. The view's areas read context on
 * mount, so setting it after `showView` makes the first fetch run against the
 * previous region - which looks like a data problem rather than an ordering one.
 */
export function applyResolvedParams(
  resolved: ResolvedViewParams,
  opts: {
    setContext: (key: string, value: unknown) => void;
    showView: (viewId: string, state?: Record<string, unknown>) => void;
  },
): boolean {
  for (const [k, v] of Object.entries(resolved.context)) opts.setContext(k, v);
  if (resolved.viewId) opts.showView(resolved.viewId, resolved.viewState);
  return resolved.viewId !== null || Object.keys(resolved.context).length > 0;
}

import { lazy } from 'react';
import type { ViewDef, AppRole } from './types';
import type { ParsedViewDef } from '@/components/views/view-renderer';
import { viewRegistry } from './view-registry';
import { getDisplayConfigGlobal, interpolateTokens } from './display-config';

interface AreaDef {
  component: string;
  data: Record<string, unknown>;
  config?: Record<string, unknown>;
  emits?: Record<string, string>;
}

interface LayoutDef {
  columns: string;
  rows?: string;
  grid: string;
}

interface YamlViewDef {
  id: string;
  label: string;
  description: string;
  hidden?: boolean;
  // Nav grouping section (e.g. "Core", "Optimization", "Location"). Omitted => "Core".
  category?: string;
  // Config-driven role tagging (simulated view filter). Omitted => all roles.
  roles?: AppRole[];
  layout: {
    default: LayoutDef;
    tablet?: LayoutDef;
    mobile?: LayoutDef;
  };
  areas: Record<string, AreaDef>;
}

export type ViewsConfig = Record<string, Omit<YamlViewDef, 'id'>>;

// Neutral data-layer DB the dashboards bind to (config-driven; FLEET_APP default).
const DEFAULT_DATA_LAYER_DB = 'FLEET_APP';

// Schemas a view's area queries reference, e.g. <DB>.DWELL.VW_X -> "DWELL".
function viewSchemas(view: YamlViewDef, db: string): Set<string> {
  const out = new Set<string>();
  const fqnRe = new RegExp(`${db}\\.([A-Za-z0-9_]+)\\.`, 'g');
  for (const area of Object.values(view.areas ?? {})) {
    const q = (area?.data as { query?: string } | undefined)?.query;
    if (typeof q !== 'string') continue;
    let m: RegExpExecArray | null;
    fqnRe.lastIndex = 0;
    while ((m = fqnRe.exec(q)) !== null) out.add(m[1]);
  }
  return out;
}

function createLazyViewComponent(viewDef: YamlViewDef) {
  return lazy(() =>
    import('@/components/views/view-renderer').then((mod) => ({
      default: function YamlDrivenView() {
        return <mod.ViewRenderer viewDef={viewDef} />;
      },
    })),
  );
}

// Surfacing gate: a view whose query references a schema in `disabledSchemas`
// (the pack's data did not resolve - see /api/pack-status) is registered but
// hidden, so the view-picker (which filters !hidden) omits it. Pass an empty
// set to surface everything. `dataLayerDb` is the neutral DB prefix used to
// derive each view's schema set (defaults to FLEET_APP for fleet back-compat).
export function registerViewsFromConfig(
  config: ViewsConfig,
  disabledSchemas?: Set<string>,
  dataLayerDb: string = DEFAULT_DATA_LAYER_DB,
): void {
  const views: YamlViewDef[] = Object.entries(config).map(([id, def]) => ({ id, ...def } as YamlViewDef));
  const display = getDisplayConfigGlobal();
  for (const view of views) {
    const schemas = disabledSchemas?.size ? viewSchemas(view, dataLayerDb) : null;
    const gatedOff = schemas ? [...schemas].some((s) => disabledSchemas!.has(s)) : false;
    const registration: ViewDef = {
      id: view.id,
      label: interpolateTokens(view.label, display),
      description: interpolateTokens(view.description, display),
      hidden: view.hidden || gatedOff,
      category: view.category ?? 'Core',
      roles: view.roles,
      component: createLazyViewComponent(view),
    };
    viewRegistry.register(registration);
  }
}

// Reserved id for the single ephemeral, agent-emitted page. Hidden from the
// view-picker / persona nav; opened directly by id via showView (which bypasses
// the role-filtered list()), so it renders under any selectedRole.
export const DYNAMIC_VIEW_ID = '__dynamic__';

// Register (overwrite) the single ephemeral dynamic view from an already-parsed,
// validated spec. Tokens in label/description are interpolated to match the app
// vocabulary (mirrors registerViewsFromConfig). Returns the id to activate.
export function registerDynamicView(spec: ParsedViewDef): string {
  const display = getDisplayConfigGlobal();
  const viewSpec: ParsedViewDef = { ...spec, id: DYNAMIC_VIEW_ID };
  const registration: ViewDef = {
    id: DYNAMIC_VIEW_ID,
    label: interpolateTokens(spec.label, display),
    description: interpolateTokens(spec.description, display),
    hidden: true, // never in the picker / persona nav
    category: 'Core',
    roles: undefined, // visible under any selected role (opened directly by id)
    component: createLazyViewComponent(viewSpec as unknown as YamlViewDef),
  };
  viewRegistry.register(registration);
  return DYNAMIC_VIEW_ID;
}

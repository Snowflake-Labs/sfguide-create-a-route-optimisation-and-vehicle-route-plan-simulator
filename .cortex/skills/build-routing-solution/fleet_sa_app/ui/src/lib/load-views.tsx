import { lazy } from 'react';
import type { ViewDef } from './types';
import { viewRegistry } from './view-registry';

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
  layout: {
    default: LayoutDef;
    tablet?: LayoutDef;
    mobile?: LayoutDef;
  };
  areas: Record<string, AreaDef>;
}

export type ViewsConfig = Record<string, Omit<YamlViewDef, 'id'>>;

// Schemas a view's area queries reference, e.g. FLEET_APP.DWELL.VW_X -> "DWELL".
const FQN_RE = /FLEET_APP\.([A-Za-z0-9_]+)\./g;
function viewSchemas(view: YamlViewDef): Set<string> {
  const out = new Set<string>();
  for (const area of Object.values(view.areas ?? {})) {
    const q = (area?.data as { query?: string } | undefined)?.query;
    if (typeof q !== 'string') continue;
    let m: RegExpExecArray | null;
    FQN_RE.lastIndex = 0;
    while ((m = FQN_RE.exec(q)) !== null) out.add(m[1]);
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
// set to surface everything.
export function registerViewsFromConfig(config: ViewsConfig, disabledSchemas?: Set<string>): void {
  const views: YamlViewDef[] = Object.entries(config).map(([id, def]) => ({ id, ...def } as YamlViewDef));
  for (const view of views) {
    const schemas = disabledSchemas?.size ? viewSchemas(view) : null;
    const gatedOff = schemas ? [...schemas].some((s) => disabledSchemas!.has(s)) : false;
    const registration: ViewDef = {
      id: view.id,
      label: view.label,
      description: view.description,
      hidden: view.hidden || gatedOff,
      component: createLazyViewComponent(view),
    };
    viewRegistry.register(registration);
  }
}

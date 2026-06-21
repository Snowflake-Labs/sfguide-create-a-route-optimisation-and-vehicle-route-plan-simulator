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

function createLazyViewComponent(viewDef: YamlViewDef) {
  return lazy(() =>
    import('@/components/views/view-renderer').then((mod) => ({
      default: function YamlDrivenView() {
        return <mod.ViewRenderer viewDef={viewDef} />;
      },
    })),
  );
}

export function registerViewsFromConfig(config: ViewsConfig): void {
  const views: YamlViewDef[] = Object.entries(config).map(([id, def]) => ({ id, ...def } as YamlViewDef));
  for (const view of views) {
    const registration: ViewDef = {
      id: view.id,
      label: view.label,
      description: view.description,
      hidden: view.hidden,
      component: createLazyViewComponent(view),
    };
    viewRegistry.register(registration);
  }
}

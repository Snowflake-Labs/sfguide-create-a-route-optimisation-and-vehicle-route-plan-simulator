import type { ComponentType } from 'react';
import { inlineRegistry } from '@/lib/inline-registry';
import { StatCard } from './stat-card';
import { DataTable } from './data-table';
import { ConfirmAction } from './confirm-action';
import { ChoiceList } from './choice-list';
import { InlinePicker } from './inline-picker';
import { ProgressCard } from './progress-card';
import { RouteMapInline } from './route-map-inline';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyComponent = ComponentType<any>;

export function registerInlineComponents() {
  inlineRegistry.register({ toolName: 'render_stat', component: StatCard as AnyComponent, maxHeight: 300 });
  inlineRegistry.register({ toolName: 'render_table', component: DataTable as AnyComponent, maxHeight: 400 });
  inlineRegistry.register({ toolName: 'render_confirm', component: ConfirmAction as AnyComponent });
  // propose_write tool responses render as ConfirmAction so the user confirms before the write is committed
  inlineRegistry.register({ toolName: 'propose_write', component: ConfirmAction as AnyComponent });
  inlineRegistry.register({ toolName: 'render_choices', component: ChoiceList as AnyComponent });
  inlineRegistry.register({ toolName: 'render_picker', component: InlinePicker as AnyComponent });
  inlineRegistry.register({ toolName: 'render_progress', component: ProgressCard as AnyComponent });
}

// Binds routing tool outputs to the inline deck.gl map. The tool names come
// from app-config.json `tools.mapTools` (fetched by app-shell), so a non-fleet
// domain declares its own map-producing tools without editing this file.
// Re-registration is overwrite-safe; safe to call again when config reloads.
export function registerToolMaps(mapTools: string[]): void {
  const routeMap = RouteMapInline as AnyComponent;
  for (const toolName of mapTools) {
    inlineRegistry.register({ toolName, component: routeMap });
  }
}

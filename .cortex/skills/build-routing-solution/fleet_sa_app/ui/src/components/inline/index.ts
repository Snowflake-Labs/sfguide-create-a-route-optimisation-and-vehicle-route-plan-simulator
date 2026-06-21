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
  // Fleet routing tools (FLEET_USER_MCP) -> render result geometry on a deck.gl map.
  const routeMap = RouteMapInline as AnyComponent;
  inlineRegistry.register({ toolName: 'get_directions', component: routeMap });
  inlineRegistry.register({ toolName: 'optimize_routes', component: routeMap });
  inlineRegistry.register({ toolName: 'compute_isochrone', component: routeMap });
  inlineRegistry.register({ toolName: 'find_poi', component: routeMap });
  inlineRegistry.register({ toolName: 'pharma_catchment', component: routeMap });
}

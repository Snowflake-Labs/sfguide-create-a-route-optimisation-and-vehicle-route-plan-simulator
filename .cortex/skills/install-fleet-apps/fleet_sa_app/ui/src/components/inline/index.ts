import type { ComponentType } from 'react';
import { inlineRegistry } from '@/lib/inline-registry';
import { StatCard } from './stat-card';
import { DataTable } from './data-table';
import { ConfirmAction } from './confirm-action';
import { ChoiceList } from './choice-list';
import { InlinePicker } from './inline-picker';
import { ProgressCard } from './progress-card';
import { ChartInline } from './chart-inline';
// The two inline MAPS load through a lazy boundary so deck.gl + maplibre-gl stay
// out of the initial bundle; this module is imported eagerly by the chat tree.
import {
  RenderMapInlineDeferred,
  RouteMapInlineDeferred,
} from '../views/areas/map-deferred';

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
  // render_map: the agent's declarative inline map (the render_map synapse verb).
  // Distinct from registerToolMaps below - that binds ROUTING tool payloads to the
  // GeoJSON-scavenging RouteMapInline, whereas this one runs the spec's own
  // queries through the owner's-rights dynamic boundary and compiles them with
  // the shared layer compiler the dashboard maps use.
  inlineRegistry.register({ toolName: 'render_map', component: RenderMapInlineDeferred as AnyComponent });
  // render_chart: emitted by cortex-stream for the `response.chart` event
  // (Cortex data_to_chart). Unregistered until now, so a chart rendered as a
  // collapsed JSON blob.
  inlineRegistry.register({ toolName: 'render_chart', component: ChartInline as AnyComponent });
}

// Binds routing tool outputs to the inline deck.gl map. The tool names come
// from app-config.json `tools.mapTools` (fetched by app-shell), so a non-fleet
// domain declares its own map-producing tools without editing this file.
// Re-registration is overwrite-safe; safe to call again when config reloads.
export function registerToolMaps(mapTools: string[]): void {
  const routeMap = RouteMapInlineDeferred as AnyComponent;
  for (const toolName of mapTools) {
    inlineRegistry.register({ toolName, component: routeMap });
  }
}

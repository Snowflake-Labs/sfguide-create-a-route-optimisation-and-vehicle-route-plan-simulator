import type { ComponentType } from 'react';
import { inlineRegistry } from '@/lib/inline-registry';
import { CHART_TOOL_ALIASES } from '@/lib/tool-names';
// Pure, import-free geometry probe: lets a mapTool registration decline a
// payload that has no geometry without loading the map itself.
import { hasGeoJSONFeatures } from '@/lib/map/scavenge-geojson';
import { StatCard } from './stat-card';
import { DataTable } from './data-table';
import { ConfirmAction } from './confirm-action';
import { ChoiceList } from './choice-list';
import { InlinePicker } from './inline-picker';
import { ProgressCard } from './progress-card';
// Charts load through a lazy boundary for the same reason the maps do: vega +
// vega-lite must stay out of the initial bundle.
import { ChartInlineDeferred } from './chart-deferred';
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
  // CHARTS. Registered under EVERY name a chart result can arrive as - which is
  // the whole bug this closes. The registry only knew `render_chart`, so the real
  // `data_to_chart` tool_result matched nothing and fell through to the collapsed
  // JSON viewer; an unregistered tool is a LEGAL state, so the miss was silent.
  // Maps worked because `render_map` happens to be registered under the name it
  // actually arrives with. The host also emits a DUPLICATE `response.chart` event
  // for the same chart (measured in AGENT_TURN.TOOLS_USED), which is why both
  // names are bound here and why cortex-stream deduplicates on spec content -
  // otherwise every chart would now be drawn twice. Names come from
  // lib/tool-names.ts so the stream and the registry cannot drift apart.
  for (const toolName of CHART_TOOL_ALIASES) {
    inlineRegistry.register({ toolName, component: ChartInlineDeferred as AnyComponent });
  }
}

// Binds routing tool outputs to the inline deck.gl map. The tool names come
// from app-config.json `tools.mapTools` (fetched by app-shell), so a non-fleet
// domain declares its own map-producing tools without editing this file.
// Re-registration is overwrite-safe; safe to call again when config reloads.
//
// `geometryTools` is the subset whose OUTPUT IS geometry (directions, an
// isochrone, a solved tour). For those, a payload with no GeoJSON is a genuine
// failure and the map says so. Every other mapTool may legitimately answer with
// counts or rows - `find_poi` grouped by category, say - and for those the map
// declines the payload so the chat shows the data instead of the stub
// "No map geometry in this result.", which is what put two content-free notices
// under one correct map. Omitted (or empty) means no tool is treated as
// geometry-mandatory, so a domain that does not declare the split never shows a
// stub.
export function registerToolMaps(mapTools: string[], geometryTools: string[] = []): void {
  const routeMap = RouteMapInlineDeferred as AnyComponent;
  const mandatory = new Set(geometryTools);
  for (const toolName of mapTools) {
    inlineRegistry.register(
      mandatory.has(toolName)
        ? { toolName, component: routeMap }
        : { toolName, component: routeMap, shouldRender: hasGeoJSONFeatures },
    );
  }
}

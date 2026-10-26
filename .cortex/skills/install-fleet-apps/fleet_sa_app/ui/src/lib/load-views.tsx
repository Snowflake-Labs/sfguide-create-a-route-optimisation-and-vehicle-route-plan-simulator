import { lazy } from 'react';
import type { ViewDef, AgentKnowledge, AppRole, UseCase, ViewUnavailable } from './types';
import type { ParsedViewDef } from '@/components/views/view-renderer';
import { viewRegistry } from './view-registry';
import { getDisplayConfigGlobal, interpolateTokens } from './display-config';
import { viewSchemas, type LayerStatus } from './view-deps';

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
  // Presenter/agent description of the use case (see UseCase). Drives the "i"
  // info overlay and the agent's solution catalog.
  useCase?: UseCase;
  // Nav grouping section (e.g. "Core", "Optimization", "Location"). Omitted => "Core".
  category?: string;
  // Config-driven role tagging (simulated view filter). Omitted => all roles.
  roles?: AppRole[];
  // Optional per-view grounding hint for the chat agent (see AgentKnowledge).
  agentKnowledge?: AgentKnowledge;
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

// Schemas a view reads come from lib/view-deps.ts (every nested query, not just
// top-level areas).

// The first absent layer this view reads, as the reason it is unavailable.
function unavailableFor(
  view: YamlViewDef,
  layers: Record<string, LayerStatus> | undefined,
  db: string,
): ViewUnavailable | undefined {
  if (!layers) return undefined;
  const missing = [...viewSchemas(view, db)].filter((s) => layers[s]?.state === 'absent');
  if (!missing.length) return undefined;
  const first = layers[missing[0]];
  return { schemas: missing, object: first.object, label: first.label, fix: first.fix, note: first.note };
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

// Surfacing gate: a view that reads a layer /api/pack-status reports ABSENT is
// registered with `unavailable` set - it stays in the picker, greyed, and opens
// to the reason and rebuild steps. It used to be hidden with no reason, which
// left nobody able to tell a missing layer from a missing feature. Pass no
// layers to surface everything. `dataLayerDb` is the neutral DB prefix used to
// derive each view's schema set (defaults to FLEET_APP for fleet back-compat).
function interpolateAgentKnowledge(
  ak: AgentKnowledge | undefined,
  display: ReturnType<typeof getDisplayConfigGlobal>,
): AgentKnowledge | undefined {
  if (!ak) return undefined;
  return {
    preferredTool: ak.preferredTool,
    keyMetrics: ak.keyMetrics?.map((m) => interpolateTokens(m, display)),
    exampleQuestions: ak.exampleQuestions?.map((q) => interpolateTokens(q, display)),
    gotchas: ak.gotchas ? interpolateTokens(ak.gotchas, display) : undefined,
  };
}

// Field-aware copy so unknown JSON subfields are dropped (mirrors
// interpolateAgentKnowledge) and every authored string picks up the app vocabulary.
function interpolateUseCase(
  uc: UseCase | undefined,
  display: ReturnType<typeof getDisplayConfigGlobal>,
): UseCase | undefined {
  if (!uc) return undefined;
  const list = (items?: string[]) => items?.map((i) => interpolateTokens(i, display));
  return {
    headline: interpolateTokens(uc.headline, display),
    businessQuestion: interpolateTokens(uc.businessQuestion, display),
    audience: list(uc.audience),
    industries: list(uc.industries),
    talkTrack: list(uc.talkTrack),
    snowflakeCapabilities: list(uc.snowflakeCapabilities),
    dataRequired: list(uc.dataRequired),
    valueDrivers: list(uc.valueDrivers),
    method: uc.method ? interpolateTokens(uc.method, display) : undefined,
    caveats: uc.caveats ? interpolateTokens(uc.caveats, display) : undefined,
  };
}

export function registerViewsFromConfig(
  config: ViewsConfig,
  layers?: Record<string, LayerStatus>,
  dataLayerDb: string = DEFAULT_DATA_LAYER_DB,
): void {
  const views: YamlViewDef[] = Object.entries(config).map(([id, def]) => ({ id, ...def } as YamlViewDef));
  const display = getDisplayConfigGlobal();
  for (const view of views) {
    const unavailable = unavailableFor(view, layers, dataLayerDb);
    const registration: ViewDef = {
      id: view.id,
      label: interpolateTokens(view.label, display),
      description: interpolateTokens(view.description, display),
      useCase: interpolateUseCase(view.useCase, display),
      hidden: view.hidden,
      unavailable,
      category: view.category ?? 'Core',
      roles: view.roles,
      agentKnowledge: interpolateAgentKnowledge(view.agentKnowledge, display),
      requiredBinds: requiredBindsOf(view),
      component: createLazyViewComponent(view),
    };
    viewRegistry.register(registration);
  }
}

// Binds emitted by `required: true` filters in any FilterBar area of the view.
function requiredBindsOf(view: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  const areas = (view as { areas?: Record<string, unknown> }).areas ?? {};
  for (const area of Object.values(areas)) {
    const filters = (area as { filters?: unknown[] })?.filters;
    if (!Array.isArray(filters)) continue;
    for (const f of filters as { required?: boolean; name?: string; label?: string; emits?: Record<string, string> }[]) {
      if (!f?.required || !f.emits) continue;
      for (const key of Object.keys(f.emits)) out[key] = f.label || f.name || key;
    }
  }
  return out;
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

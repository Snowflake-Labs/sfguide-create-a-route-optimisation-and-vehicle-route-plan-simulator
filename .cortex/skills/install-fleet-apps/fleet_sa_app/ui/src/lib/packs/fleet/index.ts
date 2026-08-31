import { lazy } from 'react';
import { viewRegistry } from '@/lib/view-registry';
import type { AgentKnowledge, AppRole, UseCase } from '@/lib/types';
import packViews from './pack-views.json';

// Fleet domain pack: registers the Tier-3 showcase views (custom full-page
// components, not YAML area-views). They call User routing verbs via /api/tool
// and render results on a deck.gl map.
//
// This pack is vehicle/industry-AGNOSTIC: the routing/ops showcases
// (vrp_simulator, emergency_wizard, ops_console) are tool-driven and always
// register. Backload Matching is a neutral, DHL-free showcase gated by its
// pack probe (FLEET_APP.BACKLOAD_MATCHING.VW_TRAILERS). The remaining
// industry-vertical showcases (freight exchange, DHL NTBO) stay excluded.
//
// This module is the fleet entry in lib/packs/registry.ts. The app-shell loads
// it generically via the configured `domainPacks` array - there is no fleet
// import in the shell itself (Step 4C).
//
// WHY THE METADATA LIVES IN pack-views.json
// -----------------------------------------
// These views' useCase (Tenet 10, Channel D) and agentKnowledge (Channel C)
// blocks used to be inline object literals here. That made them invisible to
// scripts/build_view_catalog.py, which reads app-views.json, so all five were
// absent from FLEET_INTELLIGENCE.SEMANTIC.VIEW_CATALOG and the agent could not
// name a single optimization demo when asked "what can you show me" outside the
// app. The metadata now lives in the sibling pack-views.json, which BOTH this
// module and the catalog generator read, so there is one source of truth and a
// code-registered view can no longer skip the catalog. Only the lazy component
// binding stays in TypeScript, because a JSON file cannot hold an import.
interface PackViewMeta {
  label: string;
  description: string;
  category?: string;
  tags?: string[];
  roles?: AppRole[];
  useCase?: UseCase;
  agentKnowledge?: AgentKnowledge;
}

const meta = packViews as unknown as Record<string, PackViewMeta>;

// Fails loudly at registration rather than silently dropping a view, so a typo
// in either file surfaces on first load instead of as a missing nav entry.
function metaFor(id: string): PackViewMeta {
  const m = meta[id];
  if (!m) throw new Error(`pack-views.json is missing metadata for view "${id}"`);
  return m;
}

export function registerViews(_disabledSchemas?: Set<string>): void {
  viewRegistry.register({
    id: 'vrp_simulator',
    ...metaFor('vrp_simulator'),
    component: lazy(() =>
      import('@/components/views/areas/vrp-simulator').then((mod) => ({
        default: mod.VrpSimulatorView,
      })),
    ),
  });

  viewRegistry.register({
    id: 'emergency_response',
    ...metaFor('emergency_response'),
    component: lazy(() =>
      import('@/components/views/areas/emergency-response').then((mod) => ({
        default: mod.EmergencyResponseView,
      })),
    ),
  });

  // Backload Matching: neutral (DHL-free) backhaul optimizer. Loads idle trailers
  // + internal loads + external offers from the FLEET_APP.BACKLOAD_MATCHING pack,
  // builds a VROOM challenge, and solves via /api/backload/solve (contract seam).
  viewRegistry.register({
    id: 'backload_matching',
    ...metaFor('backload_matching'),
    component: lazy(() =>
      import('@/components/views/areas/backload-matching').then((mod) => ({
        default: mod.BackloadMatchingView,
      })),
    ),
  });

  // Backload Proposals: the advanced multi-strategy cockpit built on the same
  // neutral FLEET_APP.BACKLOAD_MATCHING views. Runs Quick scan / Per-load VRP /
  // Fleet 1:1 / Profit-max, fuses them via client-side ensemble scoring into a
  // graded proposal per vehicle, shows per-constraint pass/fail chips from
  // VW_CANDIDATES_SCORED, and a Cortex rationale. Solves via /api/backload/solve.
  viewRegistry.register({
    id: 'backload_proposals',
    ...metaFor('backload_proposals'),
    component: lazy(() =>
      import('@/components/views/areas/backload-proposals').then((mod) => ({
        default: mod.BackloadProposalsView,
      })),
    ),
  });

  // Ops console: operator-only platform control (service lifecycle, region, health).
  // Reaches the OPS synapse verbs via /api/ops; data-layer access is gated by the
  // app role (FLEET_APP_OPS) in production (Phase 3E).
  viewRegistry.register({
    id: 'ops_console',
    ...metaFor('ops_console'),
    component: lazy(() =>
      import('@/components/views/areas/ops-console').then((mod) => ({
        default: mod.OpsConsoleView,
      })),
    ),
  });
}

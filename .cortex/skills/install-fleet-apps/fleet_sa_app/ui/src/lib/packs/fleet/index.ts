import { lazy } from 'react';
import { viewRegistry } from '@/lib/view-registry';

// Fleet domain pack: registers the Tier-3 showcase views (custom full-page
// components, not YAML area-views). They call User routing verbs via /api/tool
// and render results on a deck.gl map.
//
// This pack is vehicle/industry-AGNOSTIC: the routing/ops showcases
// (vrp_simulator, emergency_wizard, ops_console) are tool-driven and always
// register. Industry-vertical showcases (freight exchange, backload matching,
// DHL) are intentionally excluded from this installer.
//
// This module is the fleet entry in lib/packs/registry.ts. The app-shell loads
// it generically via the configured `domainPacks` array — there is no fleet
// import in the shell itself (Step 4C).
export function registerViews(_disabledSchemas?: Set<string>): void {
  viewRegistry.register({
    id: 'vrp_simulator',
    label: 'Route Optimization Simulator',
    description: 'Plan multi-stop vehicle routes from a depot and view them on the map.',
    category: 'Optimization',
    component: lazy(() =>
      import('@/components/views/areas/vrp-simulator').then((mod) => ({
        default: mod.VrpSimulatorView,
      })),
    ),
  });

  viewRegistry.register({
    id: 'emergency_response',
    label: 'Emergency Response',
    description: 'Plan a capacitated multi-depot evacuation for the active region: county FEMA risk, isochrone-seeded participants, and a solved van routing plan. Available when the region has generated hazard + health-anchor data.',
    category: 'Optimization',
    component: lazy(() =>
      import('@/components/views/areas/emergency-response').then((mod) => ({
        default: mod.EmergencyResponseView,
      })),
    ),
  });

  // Ops console: operator-only platform control (service lifecycle, region, health).
  // Reaches the OPS synapse verbs via /api/ops; data-layer access is gated by the
  // app role (FLEET_APP_OPS) in production (Phase 3E).
  viewRegistry.register({
    id: 'ops_console',
    label: 'Ops Console',
    description: 'Operator controls: suspend/resume services, set the active region, and check platform health.',
    category: 'Admin',
    tags: ['ops', 'admin'],
    roles: ['ops'],
    component: lazy(() =>
      import('@/components/views/areas/ops-console').then((mod) => ({
        default: mod.OpsConsoleView,
      })),
    ),
  });
}

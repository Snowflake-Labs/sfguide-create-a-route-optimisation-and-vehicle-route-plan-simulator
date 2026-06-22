import { lazy } from 'react';
import { viewRegistry } from './view-registry';

// Registers the Tier-3 showcase views (custom full-page components, not YAML
// area-views). Called from app-shell on load. Both call User routing verbs via
// /api/tool and render results on a deck.gl map.
export function registerFleetViews(): void {
  viewRegistry.register({
    id: 'vrp_simulator',
    label: 'Route Optimization Simulator',
    description: 'Plan multi-stop vehicle routes from a depot and view them on the map.',
    component: lazy(() =>
      import('@/components/views/areas/vrp-simulator').then((mod) => ({
        default: mod.VrpSimulatorView,
      })),
    ),
  });

  viewRegistry.register({
    id: 'emergency_wizard',
    label: 'Emergency Response Coverage',
    description: 'Compute the drive-time reachability around an incident location.',
    component: lazy(() =>
      import('@/components/views/areas/emergency-wizard').then((mod) => ({
        default: mod.EmergencyWizardView,
      })),
    ),
  });

  viewRegistry.register({
    id: 'freight_exchange',
    label: 'Freight Exchange',
    description: 'Browse live freight offers on a map, draft AI counter-offers, and plan round trips.',
    component: lazy(() =>
      import('@/components/views/areas/freight-exchange').then((mod) => ({
        default: mod.FreightExchangeView,
      })),
    ),
  });

  viewRegistry.register({
    id: 'backload_matching',
    label: 'Backload Matching',
    description: 'Match empty trailers to external offers and plan the empty repositioning leg.',
    component: lazy(() =>
      import('@/components/views/areas/backload-matching').then((mod) => ({
        default: mod.BackloadMatchingView,
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
    tags: ['ops', 'admin'],
    component: lazy(() =>
      import('@/components/views/areas/ops-console').then((mod) => ({
        default: mod.OpsConsoleView,
      })),
    ),
  });
}

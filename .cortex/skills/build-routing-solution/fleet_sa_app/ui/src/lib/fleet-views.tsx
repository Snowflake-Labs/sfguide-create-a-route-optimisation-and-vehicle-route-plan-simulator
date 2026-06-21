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
}

import type { LayerStatus } from '@/lib/view-deps';
import { registerViews as registerFleetViews } from './fleet';

// Domain-pack registry. Each entry knows how to register its custom (non-YAML)
// showcase views into the viewRegistry. The app-shell loops over the configured
// `domainPacks` array and calls `registerViews(objects)` for each known
// pack id - so adding a domain pack is config + a registry entry, with NO edit
// to the app-shell. A pack id absent from this registry is silently ignored
// (the neutral starter ships `domainPacks: []` and registers nothing here -
// its dashboards are pure-YAML, the strongest proof the core needs no domain
// code).
//
// `objects` is /api/pack-status's per-object availability for the objects each
// pack view declares in `requires`; a pack registers a view over an absent
// object as `unavailable` (shown with its reason), never silently dropped.
export interface DomainPack {
  registerViews: (objects?: Record<string, LayerStatus>) => void;
}

export const PACK_REGISTRY: Record<string, DomainPack> = {
  fleet: { registerViews: registerFleetViews },
};

import { registerViews as registerFleetViews } from './fleet';

// Domain-pack registry. Each entry knows how to register its custom (non-YAML)
// showcase views into the viewRegistry. The app-shell loops over the configured
// `domainPacks` array and calls `registerViews(disabledSchemas)` for each known
// pack id — so adding a domain pack is config + a registry entry, with NO edit
// to the app-shell. A pack id absent from this registry is silently ignored
// (the neutral starter ships `domainPacks: []` and registers nothing here —
// its dashboards are pure-YAML, the strongest proof the core needs no domain
// code).
//
// `disabledSchemas` is the surfacing-gate set (schemas whose probe view has 0
// rows, from /api/pack-status); a pack uses it to skip data-backed views whose
// pack data is absent.
export interface DomainPack {
  registerViews: (disabledSchemas?: Set<string>) => void;
}

export const PACK_REGISTRY: Record<string, DomainPack> = {
  fleet: { registerViews: registerFleetViews },
};

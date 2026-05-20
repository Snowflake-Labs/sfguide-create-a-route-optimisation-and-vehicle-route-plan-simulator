// Shared module-level state across server routers.
//
// `activeRegionOverride` is the in-memory cache of the currently active
// region as seen by the dataset picker / regions/active endpoint. It's
// hydrated from REGION_REGISTRY at boot and is mutated by:
//   - POST /api/regions/active        (regions router)
//   - POST /api/datasets/activate     (fleet router)
// And read by:
//   - GET  /api/regions               (regions router)
//   - GET  /api/regions/active        (regions router)
//
// The setter / getter pair keeps the state encapsulated so it can be
// re-implemented (e.g. as a Redis-backed cache) without touching callers.

let activeRegionOverride: string | null = null;

export function getActiveRegionOverride(): string | null {
  return activeRegionOverride;
}

export function setActiveRegionOverride(value: string | null): void {
  activeRegionOverride = value;
}

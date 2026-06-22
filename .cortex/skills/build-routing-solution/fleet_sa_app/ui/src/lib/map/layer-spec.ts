// Re-export shim (R1): the map layer DSL types now live in the shared UI kit.
// Importers (view-map, layer-compiler) keep importing from '@/lib/map/layer-spec'
// unchanged. The deck.gl-coupled compiler + map-fit join the kit in R1 increment 2.
export * from '@fleet-kit/core/map';

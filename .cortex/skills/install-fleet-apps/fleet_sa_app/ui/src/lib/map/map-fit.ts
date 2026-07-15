// Re-export shim (R1.2): camera-fit + coordinate-extraction helpers now live in
// the shared UI kit (@fleet-kit/core/map). deck.gl + h3-js are the kit's peer deps,
// resolved to this app's single copy via next.config transpilePackages + symlinks:false.
// Importers (view-map, map-view, route-map-inline) keep importing
// from '@/lib/map/map-fit' unchanged.
export * from '@fleet-kit/core/map';

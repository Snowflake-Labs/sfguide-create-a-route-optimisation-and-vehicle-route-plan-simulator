// Re-export shim (R1.2): the deck.gl layer compiler now lives in the shared UI kit
// (@fleet-kit/core/map). Importers (view-map) keep importing compileLayer /
// layerFitCoords from '@/lib/map/layer-compiler' unchanged.
export * from '@fleet-kit/core/map';

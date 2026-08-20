// @fleet-kit/core/map - map DSL barrel.
//   layer-spec      pure DSL types (no runtime deps)
//   map-fit         camera-fit + coordinate extraction (peer: @deck.gl/core, h3-js)
//   layer-compiler  LayerSpec -> deck.gl Layer instances (peer: @deck.gl/core, /layers, /geo-layers)
//
// deck.gl + h3-js are PEER dependencies: the consuming app supplies the single
// copy so layer instances are the same classes the app's DeckGL canvas renders
// (a duplicate deck.gl copy silently breaks rendering). The consumer Next app
// dedupes via next.config `transpilePackages: ['@fleet-kit/core']` + webpack
// `resolve.symlinks = false`.
export * from './layer-spec';
export * from './map-fit';
export * from './simplify';
export * from './layer-compiler';

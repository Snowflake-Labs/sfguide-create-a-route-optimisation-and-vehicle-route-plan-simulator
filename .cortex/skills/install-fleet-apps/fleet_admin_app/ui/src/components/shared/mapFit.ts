// Re-export shim: camera-fit + coordinate-extraction helpers live in the shared
// UI kit (@fleet-kit/core/map), matching the SA app's src/lib/map/map-fit.ts.
//
// This file was a verbatim copy of the kit's map-fit.ts, so every fix to the fit
// maths had to be applied twice and silently was not - the admin app kept the
// pre-hardening version while the kit gained out-of-range coordinate rejection,
// h3 cell validation and a clamped fit inset. A shim removes the class of bug
// rather than resynchronising the copy.
//
// deck.gl + h3-js are the kit's peer deps, resolved to this app's single copy via
// next.config transpilePackages + symlinks:false. Importers (useFitMap, MapView,
// useH3FitMap, RegionBoundaryMap, ResultMap, matrix-viewer) keep importing from
// './mapFit' / '@/components/shared/mapFit' unchanged.
export * from '@fleet-kit/core/map';

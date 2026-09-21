'use client';

// Re-export shim: the CARTO vector basemap lives in the shared UI kit
// (@fleet-kit/core/map-react), matching how src/lib/map/* shims @fleet-kit/core/map.
//
// This file and fleet_admin_app/ui/src/components/shared/basemap.tsx were
// duplicates differing only in one word of one comment, so the attribution
// invariant, the SSR-safe lazy import and the WebGL-context cleanup all existed
// twice and had to be fixed twice.
//
// Importers (map-view.tsx here; MapView, ResultMap and matrix-viewer in the
// admin app) keep their existing default import unchanged.
export { Basemap as default } from '@fleet-kit/core/map-react';
export type { BasemapProps, BasemapViewState } from '@fleet-kit/core/map-react';

// Top-level src/api/ barrel. Import the typed, region-aware client like:
//   import { listMatrixRegions } from '@/api/matrix';
//
// Modules are added here as their pages are ported (R5): matrix now; regions,
// studio, fleet land with Region Builder (R5.6) and Data Studio (R5.9).

export * from './client';
export * from './matrix';

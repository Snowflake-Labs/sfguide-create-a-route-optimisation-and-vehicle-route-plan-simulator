'use client';

// Deferred loading boundary for the map-bearing components.
//
// deck.gl plus maplibre-gl is the largest dependency either app carries, and the
// SA app is a single route: everything reachable from the view renderer lands in
// the initial bundle whether or not the user opens a map. Baseline before this
// file: / was 543 kB (645 kB first load).
//
// The pack-registered areas (emergency-response, backload-matching,
// backload-proposals, triangle-proposals) were already lazy via
// lib/packs/fleet/index.ts, so ProposalMap's deck.gl import already sat in a
// split chunk. The two paths that were not are the ones handled here:
//   1. view-renderer -> areas barrel -> view-map -> map-view -> deck.gl
//   2. components/inline/index.ts -> RenderMapInline / RouteMapInline -> deck.gl
//
// Each wrapper owns its Suspense boundary rather than leaving it to the call
// site, because both call sites render a component looked up from a registry and
// have no way to know which entries need one.

import { lazy, Suspense, type ComponentType } from 'react';

/** Neutral placeholder sized like a map area, so the grid does not reflow on load. */
function MapLoading({ height }: { height?: number }) {
  return (
    <div
      style={{
        position: 'relative',
        width: '100%',
        height: height ?? '100%',
        minHeight: 200,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        // Matches the basemap's own light tone so the swap is not a flash.
        background: 'var(--surface-2, #f4f5f7)',
        color: 'var(--text-secondary, #6b7280)',
        fontSize: 13,
      }}
    >
      Loading map...
    </div>
  );
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyProps = any;

const ViewMapAreaInner = lazy(() =>
  import('./view-map').then((m) => ({ default: m.ViewMapArea as ComponentType<AnyProps> })),
);

/** Registered as `Map` in view-renderer AREA_COMPONENTS in place of ViewMapArea. */
export function ViewMapAreaDeferred(props: AnyProps) {
  const height = (props?.config as { height?: number } | undefined)?.height;
  return (
    <Suspense fallback={<MapLoading height={height} />}>
      <ViewMapAreaInner {...props} />
    </Suspense>
  );
}

const RenderMapInlineInner = lazy(() =>
  import('../../inline/render-map-inline').then((m) => ({
    default: m.RenderMapInline as ComponentType<AnyProps>,
  })),
);

/** Inline chat map for the render_map verb. */
export function RenderMapInlineDeferred(props: AnyProps) {
  return (
    <Suspense fallback={<MapLoading height={280} />}>
      <RenderMapInlineInner {...props} />
    </Suspense>
  );
}

const RouteMapInlineInner = lazy(() =>
  import('../../inline/route-map-inline').then((m) => ({
    default: m.RouteMapInline as ComponentType<AnyProps>,
  })),
);

/** Inline chat map bound to routing tool payloads. */
export function RouteMapInlineDeferred(props: AnyProps) {
  return (
    <Suspense fallback={<MapLoading height={280} />}>
      <RouteMapInlineInner {...props} />
    </Suspense>
  );
}

# Page Layout

The ORS Control App has a fixed-viewport shell:

- `.app` is `100vh` with `overflow: hidden`.
- `.app-content` is a flex column that holds the header and `.app-main`.
- `.app-main` either uses its own `overflow-y: auto` (narrow pages) or `overflow: hidden` (full-width tabs listed in `FULL_WIDTH_TABS` in `App.tsx`).

For full-width tabs the parent does NOT scroll, so any page rendered there must either:
1. Be a true full-bleed map/canvas that fills the area itself, OR
2. Provide its own scroller.

To make (2) trivial and consistent, use the `PageContainer` wrapper.

## When to use `PageContainer`

Use it for any page that lays out vertical content (dashboards, lists, forms,
chart grids, tables) — especially under a full-width tab. It adds:

- `width: 100%; height: 100%`
- `min-height: 0` (so the flex chain works)
- `overflow-y: auto` / `overflow-x: hidden`
- Optional padding (default on)
- Optional max-width centering (`narrow` = 1100px, `wide` = 1400px, `full` = no cap)

```tsx
import PageContainer from '../shared/PageContainer';

export default function MyPage() {
  return (
    <PageContainer width="wide">
      <h3>My Page</h3>
      {/* charts, tables, anything tall — all reachable by scrolling */}
    </PageContainer>
  );
}
```

If your page already wraps content in `<div className="panel">`, keep the panel
and place `PageContainer` outside of it. Pass `padded={false}` to avoid double
padding:

```tsx
<PageContainer width="wide" padded={false}>
  <div className="panel">...</div>
</PageContainer>
```

## When NOT to use `PageContainer`

- Pure map / canvas pages where the map fills 100% of the area (e.g. Emergency
  Response, Retail Catchment, Fleet Taxis Routes/Heatmap, Dwell Congestion Map,
  Route Deviation Comparison, Agent Playground). Those manage their own
  layout intentionally.
- Pages already known to scroll correctly under non-full-width `.app-main`
  where adding a wrapper would be redundant. Migration is opt-in.

## Rule of thumb

If a user has ever reported "I can't see all the content" or "the page won't
scroll" on a page, it should be using `PageContainer`. New pages that contain
anything taller than the viewport should adopt it from day one.

## Do NOT

- Use `height: calc(100vh - 120px)` or similar magic numbers in new code.
- Set `overflow: hidden` on a page root unless the page is a map/canvas.
- Forget `min-height: 0` somewhere in the flex chain — it is the most common
  reason an inner `overflow-y: auto` silently fails to scroll.

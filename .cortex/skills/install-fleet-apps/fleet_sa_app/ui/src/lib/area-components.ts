// Single source of truth for the area component names a view spec may use.
// Kept lightweight (no React/runtime deps) so the dynamic-spec validator
// (view-spec-schema.ts) can import it without pulling in the renderer's
// component tree. The AREA_COMPONENTS dispatch map in view-renderer.tsx is kept
// in sync with this list via `satisfies Record<AreaComponentName, ...>`.
export const AREA_COMPONENT_NAMES = [
  'MetricCards',
  'Chart',
  'Table',
  'ComboBox',
  'FilterBar',
  'Map',
  'Slider',
  'ClickableTable',
  'Checkbox',
  'EntityDetail',
  'DetailPanel',
  'Markdown',
] as const;

export type AreaComponentName = (typeof AREA_COMPONENT_NAMES)[number];

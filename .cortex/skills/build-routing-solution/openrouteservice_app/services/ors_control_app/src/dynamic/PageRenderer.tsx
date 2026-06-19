import { useMemo, useState, useCallback } from 'react';
import { useRegion } from '../hooks/useRegion';
import { useVehicleType } from '../hooks/useVehicleType';
import type { PageSpec } from './spec-types';
import { validatePageSpec, type BindingScope } from './spec-runtime';
import { getComponent, registryKeys } from './registry';

interface PageRendererProps {
  spec: PageSpec;
}

/** Normalize a grid-template-areas block into a single inline-style string. */
function gridTemplate(grid: string): string {
  return grid
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .join(' ');
}

/**
 * Renders a PageSpec: builds the binding scope from region/vehicle context,
 * owns viewState (written by FilterBar/ComboBox, read by `:param` queries),
 * lays areas out on a CSS grid, and dispatches each area to its registered
 * component. Invalid specs render a diagnostic panel instead of crashing.
 */
export default function PageRenderer({ spec }: PageRendererProps) {
  const region = useRegion();
  const vehicle = useVehicleType();
  const [viewState, setViewStateMap] = useState<Record<string, unknown>>({});

  const onViewState = useCallback((key: string, value: unknown) => {
    setViewStateMap((prev) => (prev[key] === value ? prev : { ...prev, [key]: value }));
  }, []);

  const scope: BindingScope = useMemo(() => ({
    region: {
      regionName: region.regionName,
      displayName: region.displayName,
      center: region.center,
      zoom: region.zoom,
      boundaryGeoJson: region.boundaryGeoJson,
    },
    vehicle: {
      vehicleType: vehicle.vehicleType,
      activeDatasetId: vehicle.activeDatasetId,
    },
    viewState,
  }), [region.regionName, region.displayName, region.center, region.zoom, region.boundaryGeoJson, vehicle.vehicleType, vehicle.activeDatasetId, viewState]);

  const errors = useMemo(() => validatePageSpec(spec, registryKeys()), [spec]);

  const defaults = useMemo(
    () => ({ database: spec.defaultDatabase, schema: spec.defaultSchema }),
    [spec.defaultDatabase, spec.defaultSchema],
  );

  if (errors.length > 0) {
    return (
      <div className="page-spec-errors" style={{ padding: 16 }}>
        <h3 style={{ color: '#c0392b' }}>Invalid page spec: {spec.id}</h3>
        <ul>{errors.map((e, i) => <li key={i} style={{ fontSize: 13 }}>{e}</li>)}</ul>
      </div>
    );
  }

  const layout = spec.layout.default;

  return (
    <div
      className="page-renderer"
      style={{
        display: 'grid',
        gridTemplateColumns: layout.columns,
        gridTemplateRows: layout.rows,
        gridTemplateAreas: gridTemplate(layout.grid),
        gap: 12,
        height: '100%',
        minHeight: 0,
      }}
    >
      {Object.entries(spec.areas).map(([name, area]) => {
        const Component = getComponent(area.component);
        return (
          <div key={name} className="page-area" style={{ gridArea: name, minWidth: 0, minHeight: 0 }}>
            {Component
              ? <Component area={area} scope={scope} defaults={defaults} onViewState={onViewState} />
              : <div style={{ padding: 12, color: '#c0392b' }}>Unknown component: {area.component}</div>}
          </div>
        );
      })}
    </div>
  );
}

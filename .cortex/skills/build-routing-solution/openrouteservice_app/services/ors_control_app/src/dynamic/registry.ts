import type React from 'react';
import type { AreaComponentProps } from './areas/types';
import MetricCardsArea from './areas/MetricCardsArea';
import ChartArea from './areas/ChartArea';
import TableArea from './areas/TableArea';
import FilterBarArea from './areas/FilterBarArea';
import ComboBoxArea from './areas/ComboBoxArea';
import MapArea from './areas/MapArea';

export type AreaComponent = React.ComponentType<AreaComponentProps>;

/**
 * Component registry: maps an area `component` string to a React component.
 * Mirrors SA's `AREA_COMPONENTS` map, but is open for extension via
 * `registerComponent` so Tier-3 full-page views (Step 1, task 5) and custom
 * widgets can be added without editing this file.
 */
const REGISTRY = new Map<string, AreaComponent>([
  ['MetricCards', MetricCardsArea],
  ['Chart', ChartArea],
  ['Table', TableArea],
  ['FilterBar', FilterBarArea],
  ['ComboBox', ComboBoxArea],
  ['Map', MapArea],
]);

export function registerComponent(name: string, component: AreaComponent): void {
  REGISTRY.set(name, component);
}

export function getComponent(name: string): AreaComponent | undefined {
  return REGISTRY.get(name);
}

export function registryKeys(): ReadonlySet<string> {
  return new Set(REGISTRY.keys());
}

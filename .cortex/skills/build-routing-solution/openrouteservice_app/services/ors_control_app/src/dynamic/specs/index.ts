import type { PageSpec } from '../spec-types';
import { dwellOverviewSpec } from './dwellOverview';
import { congestionMapSpec } from './congestionMap';

/**
 * Registry of declarative page specs, keyed by App.tsx nav tab key
 * (e.g. "dwell:overview", "fleet-delivery:map"). App.tsx renders a PageSpec
 * via PageRenderer when the active tab has an entry here, otherwise it falls
 * back to the hand-coded component. This map is populated as dashboards are
 * converted (Step 1, task 5) and is the set translated to SA view YAML in
 * Step 2.
 */
export const SPEC_PAGES: Record<string, PageSpec> = {
  [dwellOverviewSpec.id]: dwellOverviewSpec,
  [congestionMapSpec.id]: congestionMapSpec,
};


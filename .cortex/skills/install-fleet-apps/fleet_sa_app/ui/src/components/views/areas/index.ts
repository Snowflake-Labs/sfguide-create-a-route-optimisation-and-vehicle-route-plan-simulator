export { MetricCardsArea } from './metric-cards';
export { ViewChartArea } from './view-chart';
export { ViewTableArea } from './view-table';
export { ViewComboBoxArea } from './view-combo-box';
export { ViewFilterBarArea } from './view-filter-bar';
// ViewMapArea is deliberately NOT re-exported here. This barrel is statically
// imported by view-renderer, and a re-export of a module that pulls deck.gl +
// maplibre-gl relies on tree-shaking to stay out of the initial bundle. Import
// it through './map-deferred' instead, which is the only supported path.
export { ViewSliderArea } from './view-slider';
export { ViewClickableTableArea } from './view-clickable-table';
export { ViewCheckboxArea } from './view-checkbox';
export { MarkdownArea } from './markdown-area';

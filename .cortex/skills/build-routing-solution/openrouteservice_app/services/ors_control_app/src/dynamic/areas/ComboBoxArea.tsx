import type { ComboBoxArea as ComboBoxSpec } from '../spec-types';
import { FilterControl } from './FilterBarArea';
import type { AreaComponentProps } from './types';

/** A single labelled dropdown (one FilterControl) that emits into viewState. */
export default function ComboBoxArea({ area, scope, defaults, onViewState }: AreaComponentProps) {
  const spec = area as ComboBoxSpec;
  return (
    <div className="combobox-area">
      {spec.title && <span className="filter-label">{spec.title}</span>}
      <FilterControl filter={spec.filter} scope={scope} defaults={defaults} onViewState={onViewState} />
    </div>
  );
}

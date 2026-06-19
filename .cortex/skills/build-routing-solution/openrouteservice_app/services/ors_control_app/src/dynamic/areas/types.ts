import type { AreaSpec } from '../spec-types';
import type { BindingScope } from '../spec-runtime';

/** Props every area component receives from the PageRenderer. */
export interface AreaComponentProps {
  area: AreaSpec;
  scope: BindingScope;
  defaults: { database?: string; schema?: string };
  /** Write a value into the page's viewState (used by FilterBar/ComboBox). */
  onViewState?: (key: string, value: unknown) => void;
}

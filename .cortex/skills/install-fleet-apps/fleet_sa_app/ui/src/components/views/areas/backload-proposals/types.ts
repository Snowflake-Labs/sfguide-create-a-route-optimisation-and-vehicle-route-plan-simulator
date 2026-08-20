// Cockpit-local types for the Backload Proposals dispatcher view. The heavy
// scoring types (ScoredPair / RankedPair / RankedTrailer / EnsembleWeights,
// etc.) live in ../backload-ensemble; these are the UI-shell types.

// Session-only decision a dispatcher records against a proposal (not persisted).
export type Decision = 'ACCEPT' | 'REJECT' | 'FLAG';

export interface DecisionState {
  action: Decision;
  reason?: string;
}

// One constraint check chip (from VW_CANDIDATES_SCORED).
export interface ChipDef {
  label: string;
  ok: boolean;
}

// Which master list is shown.
export type Perspective = 'vehicles' | 'loads' | 'ensemble';

// Distance basis for the ensemble run: straight-line (fast, quick-scan only) or
// road (all four strategies, real ORS/VROOM routing).
export type EnsembleBasis = 'great_circle' | 'road';

// Client-side filter state for the cockpit.
export interface FilterState {
  country: string;              // operating country, '' = any
  source: '' | 'internal' | 'external';
  feasibleOnly: boolean;        // eligible pairs only
  maxEmptyKm: number | '';      // cap on empty km
  decision: 'ANY' | 'UNDECIDED' | 'ACCEPT' | 'REJECT' | 'FLAG';
  hideSameOriginDest: boolean;  // hide pairs whose empty origin == next start
}

export const INITIAL_FILTERS: FilterState = {
  country: '', source: '', feasibleOnly: false, maxEmptyKm: '', decision: 'ANY', hideSameOriginDest: false,
};

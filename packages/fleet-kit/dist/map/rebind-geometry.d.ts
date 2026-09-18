import type { LayerSpec } from './layer-spec';
export interface RebindNote {
    /** Encoding field that was rebound, e.g. 'hexColumn' or 'lng/lat'. */
    field: string;
    /** The unresolvable column name the spec asked for. */
    from: string;
    /** The column actually bound. */
    to: string;
    /** Why detection believes `to` is geometry (from detectGeoColumns). */
    reason: string;
}
export interface RebindResult {
    layer: LayerSpec;
    note?: RebindNote;
}
type Row = Record<string, unknown>;
/**
 * Rebind `layer`'s geometry encoding when it names a column absent from `rows`.
 *
 * `columns` carries the DECLARED Snowflake type per column, which is what makes
 * a GEOGRAPHY column bindable with no value sniffing at all (and is the only
 * signal that survives a result with rows the sample does not reach).
 *
 * Returns the layer unchanged, with no note, whenever there is nothing to fix or
 * nothing safe to fix it with.
 */
export declare function rebindLayerGeometry(layer: LayerSpec, columns: Array<{
    key: string;
    label?: string;
    type?: string;
}> | undefined, rows: Row[] | undefined): RebindResult;
export {};
//# sourceMappingURL=rebind-geometry.d.ts.map
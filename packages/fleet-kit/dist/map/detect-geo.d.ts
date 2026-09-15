/** Snowflake column type as reported in result metadata, lowercased. */
export type GeoColumnType = string;
export interface DetectColumn {
    name: string;
    /** Snowflake type name from result metadata, e.g. 'GEOGRAPHY', 'TEXT', 'FIXED'. */
    type: GeoColumnType;
}
export type DetectedLayerType = 'scatterplot' | 'geojson' | 'h3';
export interface GeoDetection {
    /** Layer type to bind; maps onto LayerSpec.type. */
    type: DetectedLayerType;
    /** Column holding GeoJSON (geojson) or H3 cell ids (h3). */
    geojsonColumn?: string;
    hexColumn?: string;
    /** Point columns (scatterplot). */
    lng?: string;
    lat?: string;
    /** Which probe matched, for surfacing "why is this a map" to a user. */
    reason: string;
}
type Row = Record<string, unknown>;
/**
 * Infers a geometry binding from result metadata plus a sample of rows, or
 * undefined when nothing in the result is usable as geometry.
 *
 * Probe order is GEOGRAPHY/GEOMETRY metadata, then H3, then GeoJSON by value,
 * then lat/lon. Declared metadata outranks every value heuristic. H3 precedes
 * GeoJSON-by-value because the two probes read the same TEXT columns and an H3
 * id can never parse as GeoJSON, so ordering them this way costs nothing and
 * keeps the cheaper check first.
 */
export declare function detectGeoColumns(columns: DetectColumn[] | null | undefined, rows: Row[] | null | undefined): GeoDetection | undefined;
export {};
//# sourceMappingURL=detect-geo.d.ts.map
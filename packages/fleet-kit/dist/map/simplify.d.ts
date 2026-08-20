/** Default max vertices kept per line before decimation kicks in. */
export declare const DEFAULT_MAX_PATH_POINTS = 500;
/**
 * Stride-decimate a line's coordinates down to at most `maxPoints`, always
 * keeping the first and last vertex so endpoints stay anchored. Returns the
 * input unchanged when it is already within the cap (or the cap is <= 0).
 */
export declare function decimateLineCoords<T extends number[]>(coords: T[], maxPoints?: number): T[];
/**
 * Return a geometry with its LineString / MultiLineString coordinates decimated
 * to `maxPoints`. Non-line geometries (Point, Polygon, MultiPolygon, and any
 * GeometryCollection members that are not lines) are returned untouched. The
 * returned object is a shallow clone when coordinates change, so callers may
 * keep the original reference for unchanged geometries.
 */
export declare function decimateGeometry<G extends {
    type?: string;
    coordinates?: any;
    geometries?: any[];
}>(geom: G, maxPoints?: number): G;
//# sourceMappingURL=simplify.d.ts.map
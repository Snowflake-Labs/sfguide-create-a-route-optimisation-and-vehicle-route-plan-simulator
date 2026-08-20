// Shared geometry decimation for map layers. Heavy route GeoJSON (Europe-scale
// road geometry can exceed 20 MB) carries thousands of vertices per line; drawn
// at full resolution it inflates the GPU coordinate buffers and the main-thread
// coordinate walk, which is what freezes the basemap. Decimating each line to a
// bounded vertex count preserves the visible shape while making compile + upload
// cheap. This is the single reusable helper every map path flows through (the
// layer compiler, the inline chat map, and the admin function tester all call
// it) so the cap is applied uniformly.
//
// Lines only: LineString / MultiLineString coordinates are decimated. Polygon
// and MultiPolygon rings are left intact so small rings (e.g. isochrone bands)
// are not distorted or self-intersected by dropping vertices.

/** Default max vertices kept per line before decimation kicks in. */
export const DEFAULT_MAX_PATH_POINTS = 500;

/**
 * Stride-decimate a line's coordinates down to at most `maxPoints`, always
 * keeping the first and last vertex so endpoints stay anchored. Returns the
 * input unchanged when it is already within the cap (or the cap is <= 0).
 */
export function decimateLineCoords<T extends number[]>(coords: T[], maxPoints = DEFAULT_MAX_PATH_POINTS): T[] {
  if (!Array.isArray(coords) || maxPoints <= 0 || coords.length <= maxPoints) return coords;
  const stride = Math.ceil(coords.length / maxPoints);
  const out: T[] = [];
  for (let i = 0; i < coords.length; i += stride) out.push(coords[i]);
  const last = coords[coords.length - 1];
  if (out[out.length - 1] !== last) out.push(last);
  return out;
}

/**
 * Return a geometry with its LineString / MultiLineString coordinates decimated
 * to `maxPoints`. Non-line geometries (Point, Polygon, MultiPolygon, and any
 * GeometryCollection members that are not lines) are returned untouched. The
 * returned object is a shallow clone when coordinates change, so callers may
 * keep the original reference for unchanged geometries.
 */
export function decimateGeometry<G extends { type?: string; coordinates?: any; geometries?: any[] }>(
  geom: G,
  maxPoints = DEFAULT_MAX_PATH_POINTS,
): G {
  if (!geom || typeof geom !== 'object') return geom;
  switch (geom.type) {
    case 'LineString': {
      const next = decimateLineCoords(geom.coordinates as number[][], maxPoints);
      return next === geom.coordinates ? geom : { ...geom, coordinates: next };
    }
    case 'MultiLineString': {
      const lines = geom.coordinates as number[][][];
      if (!Array.isArray(lines)) return geom;
      let changed = false;
      const next = lines.map((line) => {
        const d = decimateLineCoords(line, maxPoints);
        if (d !== line) changed = true;
        return d;
      });
      return changed ? { ...geom, coordinates: next } : geom;
    }
    case 'GeometryCollection': {
      const members = geom.geometries;
      if (!Array.isArray(members)) return geom;
      let changed = false;
      const next = members.map((g) => {
        const d = decimateGeometry(g, maxPoints);
        if (d !== g) changed = true;
        return d;
      });
      return changed ? { ...geom, geometries: next } : geom;
    }
    default:
      return geom;
  }
}

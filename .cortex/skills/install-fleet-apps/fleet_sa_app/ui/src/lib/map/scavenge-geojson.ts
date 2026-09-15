// Pulls GeoJSON out of an arbitrary routing tool payload.
//
// Extracted from components/inline/route-map-inline.tsx so the SCAVENGE can be
// called without loading the MAP. route-map-inline sits behind a lazy boundary
// on purpose (it carries deck.gl + maplibre-gl, which must stay out of the
// initial bundle), but the registry has to decide whether a payload has any
// geometry at all BEFORE choosing a renderer - and that decision is eagerly
// evaluated in the chat tree. This module imports nothing, so asking the
// question costs nothing.
//
// The deep scan is deliberate: the exact ORS/VROOM response shape varies per
// tool, and geometry turns up as a FeatureCollection, a bare Feature, a bare
// geometry, or any of those serialized inside a string field.

function looksLikeGeoJSONString(s: string): boolean {
  const t = s.trim();
  return t.startsWith('{') && (t.includes('"coordinates"') || t.includes('"FeatureCollection"') || t.includes('"geometry"'));
}

export function collectFeatures(node: unknown, out: GeoJSON.Feature[], depth = 0): void {
  if (node == null || depth > 8) return;
  if (typeof node === 'string') {
    if (looksLikeGeoJSONString(node)) {
      try { collectFeatures(JSON.parse(node), out, depth + 1); } catch { /* not json */ }
    }
    return;
  }
  if (Array.isArray(node)) {
    for (const item of node) collectFeatures(item, out, depth + 1);
    return;
  }
  if (typeof node === 'object') {
    const o = node as Record<string, unknown>;
    if (o.type === 'FeatureCollection' && Array.isArray(o.features)) {
      out.push(...(o.features as GeoJSON.Feature[]));
      return;
    }
    if (o.type === 'Feature' && o.geometry) {
      out.push(o as unknown as GeoJSON.Feature);
      return;
    }
    if (typeof o.type === 'string' && o.coordinates) {
      out.push({ type: 'Feature', geometry: o as unknown as GeoJSON.Geometry, properties: {} });
      return;
    }
    for (const v of Object.values(o)) collectFeatures(v, out, depth + 1);
  }
}

/** True when `payload` carries at least one drawable GeoJSON feature. */
export function hasGeoJSONFeatures(payload: unknown): boolean {
  const out: GeoJSON.Feature[] = [];
  collectFeatures(payload, out);
  return out.length > 0;
}

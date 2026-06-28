// Compiles declarative LayerSpec entries into deck.gl Layer instances.
//
// Ported verbatim from the control app (src/dynamic/layer-compiler.ts); the only
// change is the import path (./layer-spec instead of ./spec-types). This is the
// reusable map DSL Solution Accelerator lacked.
import { ScatterplotLayer, PathLayer, GeoJsonLayer, ArcLayer } from '@deck.gl/layers';
import { H3HexagonLayer } from '@deck.gl/geo-layers';
const num = (v) => Number(v);
const has = (r, ...cols) => cols.every((c) => r[c] != null);
/** Resolve a ColorValue to a constant color or a per-row accessor. */
function colorAccessor(color, viewState, fallback) {
    if (!color)
        return fallback;
    if (Array.isArray(color))
        return color;
    // CategoricalColor: per-row color by a column value via a palette.
    if ('palette' in color) {
        const cat = color;
        return (d) => cat.palette[String(d[cat.column])] ?? cat.default ?? fallback;
    }
    // ConditionalColor: highlight the selected row; otherwise optional category palette.
    const cmp = viewState[color.whenViewStateEquals];
    return (d) => {
        if (String(d[color.matchColumn]) === String(cmp))
            return color.active;
        if (color.baseColumn && color.basePalette) {
            return color.basePalette[String(d[color.baseColumn])] ?? color.base;
        }
        return color.base;
    };
}
/** Build a PathLayer data array from rows (GeoJSON LineString or start->end).
 *  Row properties are carried onto each datum so `{COLUMN}` tooltip tokens and
 *  picking resolve against the source row. */
function pathData(spec, rows) {
    const out = [];
    for (const r of rows) {
        if (spec.geojsonColumn && r[spec.geojsonColumn]) {
            try {
                const geo = JSON.parse(r[spec.geojsonColumn]);
                if (Array.isArray(geo?.coordinates) && geo.coordinates.length > 1) {
                    out.push({ ...r, path: geo.coordinates });
                    continue;
                }
            }
            catch { /* fall through to straight segment */ }
        }
        if (spec.start && spec.end && has(r, spec.start.lng, spec.start.lat, spec.end.lng, spec.end.lat)) {
            out.push({ ...r, path: [[num(r[spec.start.lng]), num(r[spec.start.lat])], [num(r[spec.end.lng]), num(r[spec.end.lat])]] });
        }
    }
    return out;
}
/** Parse a column of GeoJSON strings into a FeatureCollection. */
function geoFeatures(spec, rows) {
    const features = [];
    for (const r of rows) {
        const raw = r[spec.geojsonColumn];
        if (!raw)
            continue;
        try {
            const geom = typeof raw === 'string' ? JSON.parse(raw) : raw;
            if (geom?.type === 'FeatureCollection')
                features.push(...geom.features);
            else if (geom?.type === 'Feature')
                features.push(geom);
            else if (geom?.type)
                features.push({ type: 'Feature', geometry: geom, properties: r });
        }
        catch { /* skip unparseable */ }
    }
    return { type: 'FeatureCollection', features };
}
/**
 * Compile one LayerSpec + its fetched rows into a deck.gl Layer.
 * `index` provides a stable fallback id. Returns null when there is no data.
 */
export function compileLayer(spec, rows, viewState, index) {
    if (!rows || rows.length === 0)
        return null;
    const id = spec.id ?? `spec-layer-${index}`;
    switch (spec.type) {
        case 'scatterplot': {
            const s = spec;
            const fill = colorAccessor(s.fillColor, viewState, [100, 100, 100, 180]);
            return new ScatterplotLayer({
                id,
                data: rows.filter((r) => has(r, s.lng, s.lat)),
                getPosition: (d) => [num(d[s.lng]), num(d[s.lat])],
                getFillColor: fill,
                getRadius: s.radius ?? 80,
                radiusMinPixels: s.radiusMinPixels ?? 4,
                radiusMaxPixels: s.radiusMaxPixels ?? 12,
                pickable: s.pickable ?? false,
                updateTriggers: { getFillColor: [JSON.stringify(viewState)] },
            });
        }
        case 'path': {
            const s = spec;
            return new PathLayer({
                id,
                data: pathData(s, rows),
                getPath: (d) => d.path,
                getColor: s.color ?? [41, 181, 232, 150],
                getWidth: s.width ?? 2,
                widthMinPixels: s.widthMinPixels ?? 1,
                pickable: s.pickable ?? false,
                autoHighlight: s.pickable ?? false,
                highlightColor: s.highlightColor ?? [41, 181, 232, 220],
            });
        }
        case 'h3': {
            const s = spec;
            const vals = s.valueColumn ? rows.map((r) => num(r[s.valueColumn])).filter(Number.isFinite) : [];
            const min = vals.length ? Math.min(...vals) : 0;
            const max = vals.length ? Math.max(...vals) : 1;
            const [lo, hi] = s.colorScale ?? [[41, 181, 232, 80], [41, 181, 232, 220]];
            const lerp = (d) => {
                if (!s.valueColumn || max === min)
                    return hi;
                const t = (num(d[s.valueColumn]) - min) / (max - min);
                return [
                    Math.round(lo[0] + (hi[0] - lo[0]) * t),
                    Math.round(lo[1] + (hi[1] - lo[1]) * t),
                    Math.round(lo[2] + (hi[2] - lo[2]) * t),
                    Math.round(lo[3] + (hi[3] - lo[3]) * t),
                ];
            };
            return new H3HexagonLayer({
                id,
                data: rows.filter((r) => has(r, s.hexColumn)),
                getHexagon: (d) => d[s.hexColumn],
                getFillColor: lerp,
                extruded: s.extruded ?? false,
                getElevation: (d) => (s.valueColumn ? num(d[s.valueColumn]) : 0),
                elevationScale: s.extruded ? 20 : 0,
                pickable: s.pickable ?? false,
            });
        }
        case 'geojson': {
            const s = spec;
            return new GeoJsonLayer({
                id,
                data: geoFeatures(s, rows),
                filled: true,
                stroked: true,
                getFillColor: s.fillColor ?? [41, 181, 232, 40],
                getLineColor: s.lineColor ?? [41, 181, 232, 200],
                getLineWidth: s.lineWidth ?? 2,
                lineWidthMinPixels: 1,
                pickable: s.pickable ?? false,
            });
        }
        case 'arc': {
            const s = spec;
            return new ArcLayer({
                id,
                data: rows.filter((r) => has(r, s.source.lng, s.source.lat, s.target.lng, s.target.lat)),
                getSourcePosition: (d) => [num(d[s.source.lng]), num(d[s.source.lat])],
                getTargetPosition: (d) => [num(d[s.target.lng]), num(d[s.target.lat])],
                getSourceColor: s.sourceColor ?? [41, 181, 232, 200],
                getTargetColor: s.targetColor ?? [255, 107, 53, 200],
                getWidth: s.width ?? 2,
                pickable: s.pickable ?? false,
            });
        }
        default:
            return null;
    }
}
/** Collect [lng,lat] coordinates from a layer's rows for camera fitting. */
export function layerFitCoords(spec, rows) {
    const out = [];
    if (!rows?.length)
        return out;
    if (spec.type === 'scatterplot') {
        for (const r of rows)
            if (has(r, spec.lng, spec.lat))
                out.push([num(r[spec.lng]), num(r[spec.lat])]);
    }
    else if (spec.type === 'arc') {
        for (const r of rows) {
            if (has(r, spec.source.lng, spec.source.lat))
                out.push([num(r[spec.source.lng]), num(r[spec.source.lat])]);
            if (has(r, spec.target.lng, spec.target.lat))
                out.push([num(r[spec.target.lng]), num(r[spec.target.lat])]);
        }
    }
    else if (spec.type === 'path') {
        for (const seg of pathData(spec, rows))
            for (const p of seg.path)
                out.push([p[0], p[1]]);
    }
    return out;
}
//# sourceMappingURL=layer-compiler.js.map
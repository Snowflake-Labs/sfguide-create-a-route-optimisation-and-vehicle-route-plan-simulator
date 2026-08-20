// Compiles declarative LayerSpec entries into deck.gl Layer instances.
//
// Ported verbatim from the control app (src/dynamic/layer-compiler.ts); the only
// change is the import path (./layer-spec instead of ./spec-types). This is the
// reusable map DSL Solution Accelerator lacked.
import { ScatterplotLayer, PathLayer, GeoJsonLayer, ArcLayer } from '@deck.gl/layers';
import { H3HexagonLayer } from '@deck.gl/geo-layers';
import { cellToBoundary } from 'h3-js';
import { decimateLineCoords, decimateGeometry, DEFAULT_MAX_PATH_POINTS } from './simplify';
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
 *  picking resolve against the source row. Line coordinates are stride-decimated
 *  to spec.maxPathPoints so heavy route geometry does not overload the GPU. */
function pathData(spec, rows) {
    const cap = spec.maxPathPoints ?? DEFAULT_MAX_PATH_POINTS;
    const out = [];
    for (const r of rows) {
        if (spec.geojsonColumn && r[spec.geojsonColumn]) {
            try {
                const geo = JSON.parse(r[spec.geojsonColumn]);
                if (Array.isArray(geo?.coordinates) && geo.coordinates.length > 1) {
                    out.push({ ...r, path: decimateLineCoords(geo.coordinates, cap) });
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
/**
 * Single-parse compile: build the deck.gl Layer AND its camera-fit coordinates
 * from ONE parse pass. For `path` / `geojson` layers this parses each row's
 * GeoJSON string exactly once (the layer data and the fit coords are both
 * derived from the parsed+decimated result), instead of the double parse you get
 * from calling compileLayer + layerFitCoords separately. Non-parsing layer types
 * (scatterplot / arc / h3) delegate to those helpers, which are already cheap.
 *
 * Prefer this over calling compileLayer and layerFitCoords back-to-back when the
 * spec may carry heavy route GeoJSON - halving the parse is what keeps the
 * basemap responsive.
 */
export function compileLayerWithFit(spec, rows, viewState, index, hovered) {
    if (!rows || rows.length === 0)
        return { layer: null, fitCoords: [] };
    const id = spec.id ?? `spec-layer-${index}`;
    if (spec.type === 'path') {
        const s = spec;
        const data = pathData(s, rows);
        return { layer: buildPathLayer(s, id, data, hovered), fitCoords: fitFromPathData(data) };
    }
    if (spec.type === 'geojson') {
        const s = spec;
        const fc = geoFeatures(s, rows);
        return { layer: buildGeoJsonLayer(s, id, fc), fitCoords: fitFromFeatures(fc) };
    }
    return { layer: compileLayer(spec, rows, viewState, index, hovered), fitCoords: layerFitCoords(spec, rows) };
}
/** Parse a column of GeoJSON strings into a FeatureCollection. Line geometries
 *  are stride-decimated to spec.maxPathPoints; polygon rings are left intact. */
function geoFeatures(spec, rows) {
    const cap = spec.maxPathPoints ?? DEFAULT_MAX_PATH_POINTS;
    const features = [];
    const push = (f) => {
        if (f?.geometry)
            f = { ...f, geometry: decimateGeometry(f.geometry, cap) };
        features.push(f);
    };
    for (const r of rows) {
        const raw = r[spec.geojsonColumn];
        if (!raw)
            continue;
        try {
            const geom = typeof raw === 'string' ? JSON.parse(raw) : raw;
            if (geom?.type === 'FeatureCollection')
                for (const f of geom.features)
                    push(f);
            else if (geom?.type === 'Feature')
                push(geom);
            else if (geom?.type)
                push({ type: 'Feature', geometry: decimateGeometry(geom, cap), properties: r });
        }
        catch { /* skip unparseable */ }
    }
    return { type: 'FeatureCollection', features };
}
/** Collect [lng,lat] coords from an already-parsed PathLayer data array (no re-parse). */
function fitFromPathData(data) {
    const out = [];
    for (const seg of data)
        for (const p of seg.path)
            out.push([p[0], p[1]]);
    return out;
}
/** Recursively push finite [lng,lat] pairs from a nested coordinate array. */
function pushCoords(c, out) {
    if (!Array.isArray(c))
        return;
    if (typeof c[0] === 'number' && typeof c[1] === 'number') {
        if (Number.isFinite(c[0]) && Number.isFinite(c[1]))
            out.push([c[0], c[1]]);
        return;
    }
    for (const inner of c)
        pushCoords(inner, out);
}
/** Collect [lng,lat] coords from an already-parsed FeatureCollection (no re-parse). */
function fitFromFeatures(fc) {
    const out = [];
    for (const f of fc.features) {
        const g = f?.geometry;
        if (g?.coordinates)
            pushCoords(g.coordinates, out);
    }
    return out;
}
/** Construct a PathLayer from an already-parsed path-data array. */
function buildPathLayer(s, id, data, hovered) {
    // Hover bolding: when the hovered path belongs to this layer, widen the
    // matching journey so it visibly stands out (autoHighlight only recolors).
    const hov = hovered && hovered.layerId === id ? hovered.value : null;
    const baseWidth = s.width ?? 2;
    const widthOf = (d) => hov != null && String(d?.journey_id ?? d?.JOURNEY_ID ?? '') === String(hov)
        ? baseWidth * 2.4
        : baseWidth;
    return new PathLayer({
        id,
        data,
        getPath: (d) => d.path,
        getColor: s.color ?? [41, 181, 232, 150],
        getWidth: hov == null ? baseWidth : widthOf,
        widthMinPixels: s.widthMinPixels ?? 1,
        pickable: s.pickable ?? false,
        autoHighlight: s.pickable ?? false,
        highlightColor: s.highlightColor ?? [41, 181, 232, 220],
        updateTriggers: { getWidth: [hov] },
    });
}
/** Construct a GeoJsonLayer from an already-parsed FeatureCollection. */
function buildGeoJsonLayer(s, id, fc) {
    const fallbackFill = s.fillColor ?? [41, 181, 232, 40];
    // Per-feature choropleth: color by properties[colorColumn] via colorMap.
    const fillAccessor = s.colorColumn && s.colorMap
        ? (f) => {
            const v = f?.properties?.[s.colorColumn];
            return (v != null && s.colorMap[String(v)]) || fallbackFill;
        }
        : fallbackFill;
    return new GeoJsonLayer({
        id,
        data: fc,
        filled: true,
        stroked: true,
        getFillColor: fillAccessor,
        getLineColor: s.lineColor ?? [41, 181, 232, 200],
        getLineWidth: s.lineWidth ?? 2,
        lineWidthMinPixels: 1,
        pickable: s.pickable ?? false,
        updateTriggers: { getFillColor: [s.colorColumn, JSON.stringify(s.colorMap)] },
    });
}
/**
 * Compile one LayerSpec + its fetched rows into a deck.gl Layer.
 * `index` provides a stable fallback id. Returns null when there is no data.
 */
export function compileLayer(spec, rows, viewState, index, hovered) {
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
                stroked: s.stroked ?? false,
                getLineColor: s.lineColor ?? [90, 99, 104, 255],
                lineWidthMinPixels: s.lineWidthMinPixels ?? 1,
                pickable: s.pickable ?? false,
                updateTriggers: { getFillColor: [JSON.stringify(viewState)] },
            });
        }
        case 'path': {
            const s = spec;
            return buildPathLayer(s, id, pathData(s, rows), hovered);
        }
        case 'h3': {
            const s = spec;
            let min = 0;
            let max = 1;
            if (s.valueColumn) {
                let seen = false;
                for (const r of rows) {
                    const v = num(r[s.valueColumn]);
                    if (!Number.isFinite(v))
                        continue;
                    if (!seen) {
                        min = v;
                        max = v;
                        seen = true;
                    }
                    else {
                        if (v < min)
                            min = v;
                        if (v > max)
                            max = v;
                    }
                }
            }
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
            return buildGeoJsonLayer(s, id, geoFeatures(s, rows));
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
    else if (spec.type === 'geojson') {
        // Walk Polygon / MultiPolygon / Line coordinates so polygon layers (e.g. an
        // isochrone ring) contribute their extent to the camera fit.
        const s = spec;
        const pushCoords = (c) => {
            if (!Array.isArray(c))
                return;
            if (typeof c[0] === 'number' && typeof c[1] === 'number') {
                if (Number.isFinite(c[0]) && Number.isFinite(c[1]))
                    out.push([c[0], c[1]]);
                return;
            }
            for (const inner of c)
                pushCoords(inner);
        };
        for (const r of rows) {
            const raw = r[s.geojsonColumn];
            if (!raw)
                continue;
            try {
                const geom = typeof raw === 'string' ? JSON.parse(raw) : raw;
                const g = geom?.type === 'Feature' ? geom.geometry
                    : geom?.type === 'FeatureCollection' ? { type: 'GC', coordinates: (geom.features ?? []).map((f) => f?.geometry?.coordinates) }
                        : geom;
                if (g?.coordinates)
                    pushCoords(g.coordinates);
            }
            catch { /* skip unparseable */ }
        }
    }
    else if (spec.type === 'h3') {
        const s = spec;
        const sample = 2000;
        const stride = rows.length > sample ? Math.ceil(rows.length / sample) : 1;
        for (let i = 0; i < rows.length; i += stride) {
            const cell = rows[i]?.[s.hexColumn];
            if (typeof cell !== 'string' || cell.length < 15)
                continue;
            try {
                for (const v of cellToBoundary(cell)) {
                    const lat = v[0];
                    const lng = v[1];
                    if (Number.isFinite(lat) && Number.isFinite(lng))
                        out.push([lng, lat]);
                }
            }
            catch { /* skip invalid cell */ }
        }
    }
    return out;
}
//# sourceMappingURL=layer-compiler.js.map
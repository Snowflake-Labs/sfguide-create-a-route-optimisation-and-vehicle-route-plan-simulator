// Camera-fit + coordinate-extraction helpers for the Map area.
// Ported verbatim from the control app (src/shared/mapFit.ts). Pure module:
// only deps are @deck.gl/core (WebMercatorViewport) and h3-js.
import { WebMercatorViewport } from '@deck.gl/core';
import { cellToBoundary } from 'h3-js';
export const DEFAULT_PADDING = { top: 40, bottom: 40, left: 40, right: 40 };
export const DEFAULT_MIN_ZOOM = 2;
export const DEFAULT_MAX_ZOOM = 16;
export const SINGLE_POINT_ZOOM = 14;
function isFiniteNum(n) {
    return typeof n === 'number' && Number.isFinite(n);
}
function isValidLngLat(c) {
    return Array.isArray(c) && c.length >= 2 && isFiniteNum(c[0]) && isFiniteNum(c[1]);
}
export function coordsFromPoints(rows, getXY) {
    if (!rows || !rows.length)
        return [];
    const out = [];
    for (const r of rows) {
        const v = getXY(r);
        if (!v)
            continue;
        if (Array.isArray(v)) {
            if (isValidLngLat(v))
                out.push([v[0], v[1]]);
        }
        else {
            const lng = v.lng ?? v.longitude;
            const lat = v.lat ?? v.latitude;
            if (isFiniteNum(lng) && isFiniteNum(lat))
                out.push([lng, lat]);
        }
    }
    return out;
}
export function coordsFromH3Cells(rows, getCell, opts = {}) {
    if (!rows || !rows.length)
        return [];
    const out = [];
    const sample = opts.sample ?? 2000;
    const stride = sample > 0 && rows.length > sample ? Math.ceil(rows.length / sample) : 1;
    for (let i = 0; i < rows.length; i += stride) {
        const cell = getCell(rows[i]);
        if (!cell || typeof cell !== 'string' || cell.length < 15)
            continue;
        try {
            const verts = cellToBoundary(cell);
            for (const v of verts) {
                const lat = v[0];
                const lng = v[1];
                if (isFiniteNum(lat) && isFiniteNum(lng))
                    out.push([lng, lat]);
            }
        }
        catch { /* skip invalid */ }
    }
    return out;
}
export function coordsFromPaths(paths) {
    if (!paths)
        return [];
    const out = [];
    const arr = Array.isArray(paths) ? paths : [paths];
    for (const p of arr) {
        if (!p)
            continue;
        const path = Array.isArray(p) ? p : (p.path || p.coordinates);
        if (!Array.isArray(path))
            continue;
        for (const pt of path) {
            if (isValidLngLat(pt))
                out.push([pt[0], pt[1]]);
        }
    }
    return out;
}
function walkGeometry(geom, out) {
    if (!geom)
        return;
    const t = geom.type;
    const c = geom.coordinates;
    if (!t || !c)
        return;
    switch (t) {
        case 'Point':
            if (isValidLngLat(c))
                out.push([c[0], c[1]]);
            break;
        case 'MultiPoint':
        case 'LineString':
            for (const pt of c)
                if (isValidLngLat(pt))
                    out.push([pt[0], pt[1]]);
            break;
        case 'MultiLineString':
        case 'Polygon':
            for (const ring of c)
                for (const pt of ring)
                    if (isValidLngLat(pt))
                        out.push([pt[0], pt[1]]);
            break;
        case 'MultiPolygon':
            for (const poly of c)
                for (const ring of poly)
                    for (const pt of ring)
                        if (isValidLngLat(pt))
                            out.push([pt[0], pt[1]]);
            break;
        case 'GeometryCollection':
            if (Array.isArray(geom.geometries))
                for (const g of geom.geometries)
                    walkGeometry(g, out);
            break;
    }
}
export function coordsFromGeoJSON(input) {
    if (!input)
        return [];
    const out = [];
    let value = input;
    if (typeof value === 'string') {
        try {
            value = JSON.parse(value);
        }
        catch {
            return [];
        }
    }
    const handle = (v) => {
        if (!v)
            return;
        if (v.type === 'FeatureCollection' && Array.isArray(v.features)) {
            for (const f of v.features)
                handle(f);
        }
        else if (v.type === 'Feature') {
            walkGeometry(v.geometry, out);
        }
        else if (v.type) {
            walkGeometry(v, out);
        }
        else if (Array.isArray(v)) {
            for (const item of v)
                handle(item);
        }
    };
    handle(value);
    return out;
}
export function boundsOf(coords) {
    if (!coords || !coords.length)
        return null;
    let minLng = Infinity, minLat = Infinity, maxLng = -Infinity, maxLat = -Infinity;
    for (const c of coords) {
        if (!isValidLngLat(c))
            continue;
        if (c[0] < minLng)
            minLng = c[0];
        if (c[0] > maxLng)
            maxLng = c[0];
        if (c[1] < minLat)
            minLat = c[1];
        if (c[1] > maxLat)
            maxLat = c[1];
    }
    if (!isFiniteNum(minLng) || !isFiniteNum(minLat) || !isFiniteNum(maxLng) || !isFiniteNum(maxLat))
        return null;
    return [[minLng, minLat], [maxLng, maxLat]];
}
function clampZoom(z, minZoom, maxZoom) {
    if (!isFiniteNum(z))
        return minZoom;
    return Math.max(minZoom, Math.min(maxZoom, z));
}
function normalizePadding(p) {
    if (p == null)
        return DEFAULT_PADDING;
    if (typeof p === 'number')
        return { top: p, bottom: p, left: p, right: p };
    return p;
}
export function fitBoundsToData(opts) {
    const { width, height, coords, bounds: providedBounds, fallback = null, minZoom = DEFAULT_MIN_ZOOM, maxZoom = DEFAULT_MAX_ZOOM, } = opts;
    const padding = normalizePadding(opts.padding);
    if (!isFiniteNum(width) || !isFiniteNum(height) || width <= 0 || height <= 0) {
        return fallback;
    }
    const bounds = providedBounds ?? boundsOf(coords ?? []);
    if (!bounds)
        return fallback;
    const [[minLng, minLat], [maxLng, maxLat]] = bounds;
    const dLng = Math.abs(maxLng - minLng);
    const dLat = Math.abs(maxLat - minLat);
    if (dLng < 1e-9 && dLat < 1e-9) {
        return {
            longitude: minLng,
            latitude: minLat,
            zoom: clampZoom(SINGLE_POINT_ZOOM, minZoom, maxZoom),
            pitch: fallback?.pitch ?? 0,
            bearing: fallback?.bearing ?? 0,
        };
    }
    try {
        const vp = new WebMercatorViewport({ width, height });
        const fitted = vp.fitBounds(bounds, { padding: padding });
        return {
            longitude: fitted.longitude,
            latitude: fitted.latitude,
            zoom: clampZoom(fitted.zoom, minZoom, maxZoom),
            pitch: fallback?.pitch ?? 0,
            bearing: fallback?.bearing ?? 0,
        };
    }
    catch {
        return fallback;
    }
}
export function coordsSignature(coords) {
    if (!coords || !coords.length)
        return 'empty';
    const b = boundsOf(coords);
    if (!b)
        return 'empty';
    const [[a1, a2], [b1, b2]] = b;
    return `${coords.length}|${a1.toFixed(6)},${a2.toFixed(6)},${b1.toFixed(6)},${b2.toFixed(6)}`;
}
/** True when every coord's bounding box lies inside the current viewport. */
export function coordsWithinView(coords, view, width, height) {
    const dataBounds = boundsOf(coords ?? []);
    if (!dataBounds)
        return true;
    if (!isFiniteNum(width) || !isFiniteNum(height) || width <= 0 || height <= 0)
        return true;
    if (!isFiniteNum(view.longitude) || !isFiniteNum(view.latitude) || !isFiniteNum(view.zoom))
        return false;
    try {
        const vp = new WebMercatorViewport({
            width,
            height,
            longitude: view.longitude,
            latitude: view.latitude,
            zoom: view.zoom,
            pitch: view.pitch ?? 0,
            bearing: view.bearing ?? 0,
        });
        const viewBounds = vp.getBounds();
        if (!viewBounds)
            return false;
        const [viewMinLng, viewMinLat, viewMaxLng, viewMaxLat] = viewBounds;
        const [[minLng, minLat], [maxLng, maxLat]] = dataBounds;
        return (minLng >= viewMinLng &&
            minLat >= viewMinLat &&
            maxLng <= viewMaxLng &&
            maxLat <= viewMaxLat);
    }
    catch {
        return false;
    }
}
//# sourceMappingURL=map-fit.js.map
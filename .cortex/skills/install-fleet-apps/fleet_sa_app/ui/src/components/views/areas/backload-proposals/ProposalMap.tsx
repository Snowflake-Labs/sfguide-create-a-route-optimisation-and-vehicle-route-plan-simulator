'use client';

// deck.gl map for the Backload Proposals cockpit, built on the shared MapView.
// Renders:
//  - base scatter of ALL idle vehicles (blue) + loads (internal green / external
//    amber), so the estate is visible before/without a selection;
//  - faint empty->pickup links for every proposal in view;
//  - for the selected proposal, the road route (single line when a road path was
//    fetched, else straight colored legs) plus numbered stop markers
//    (start / pickup / delivery / next).

import { useMemo, useRef, useCallback, useEffect } from 'react';
import { ScatterplotLayer, LineLayer, GeoJsonLayer, PathLayer, TextLayer } from '@deck.gl/layers';
import MapView from '../map-view';
import { COLOR_VEHICLE, COLOR_INTERNAL, COLOR_EXTERNAL, COLOR_LEG_EMPTY, COLOR_LEG_LOADED, COLOR_LEG_NEXT } from './constants';
import { place } from './format';
import { escapeHtml } from '@/lib/html';

export interface MapVehicle { id: string; lon: number; lat: number; }
export interface MapLoad { id: string; lon: number; lat: number; internal: boolean; city: string | null; source: string | null; }
export interface MapLink { from: [number, number]; to: [number, number]; key: string; }
export type StopKind = 'start' | 'pickup' | 'delivery' | 'end';
export interface MapStop { idx: number; kind: StopKind; pos: [number, number]; city: string | null; }

interface Props {
  vehicles: MapVehicle[];
  loads: MapLoad[];
  links: MapLink[];
  stops: MapStop[];
  // Road path for the selected proposal (empty->pickup->delivery), if resolved.
  // Drawn as one accent line; when absent the map draws straight colored legs
  // between consecutive stops.
  routePath: [number, number][] | null;
  focusKey: string;
}

const STOP_PALETTE: Record<StopKind, [number, number, number]> = {
  start: COLOR_LEG_EMPTY, pickup: COLOR_EXTERNAL, delivery: COLOR_LEG_LOADED, end: COLOR_LEG_NEXT,
};
const STOP_LABEL: Record<StopKind, string> = { start: 'Start', pickup: 'Pickup', delivery: 'Delivery', end: 'Next start' };
const ROUTE_COLOR: [number, number, number] = [29, 78, 216];

export default function ProposalMap({ vehicles, loads, links, stops, routePath, focusKey }: Props) {
  const layers = useMemo(() => {
    const arr: any[] = [];

    arr.push(new ScatterplotLayer({
      id: 'bp-all-vehicles', data: vehicles,
      getPosition: (d: MapVehicle) => [d.lon, d.lat],
      getFillColor: [...COLOR_VEHICLE, 70] as any,
      getRadius: 2500, radiusMinPixels: 2, radiusMaxPixels: 6, pickable: true,
    }));
    arr.push(new ScatterplotLayer({
      id: 'bp-all-loads', data: loads,
      getPosition: (d: MapLoad) => [d.lon, d.lat],
      getFillColor: (d: MapLoad) => [...(d.internal ? COLOR_INTERNAL : COLOR_EXTERNAL), 90] as any,
      getRadius: 2600, radiusMinPixels: 2, radiusMaxPixels: 7, pickable: true,
    }));

    if (links.length) {
      arr.push(new LineLayer({
        id: 'bp-links', data: links,
        getSourcePosition: (d: MapLink) => d.from,
        getTargetPosition: (d: MapLink) => d.to,
        getColor: [150, 150, 160, 70] as any, getWidth: 1,
      }));
    }

    // Selected route: single road line when available, else straight colored legs.
    if (routePath && routePath.length > 1) {
      arr.push(new GeoJsonLayer({
        id: 'bp-route', data: { type: 'Feature', geometry: { type: 'LineString', coordinates: routePath }, properties: {} } as any,
        getLineColor: ROUTE_COLOR as any, getLineWidth: 5, lineWidthMinPixels: 3, getFillColor: [0, 0, 0, 0],
      }));
    } else if (stops.length >= 2) {
      const last = stops.length - 2;
      for (let i = 0; i < stops.length - 1; i++) {
        const color = i === 0 ? COLOR_LEG_EMPTY : (i === last ? COLOR_LEG_NEXT : COLOR_LEG_LOADED);
        arr.push(new PathLayer({
          id: `bp-leg-${i}`, data: [{ path: [stops[i].pos, stops[i + 1].pos] }], getPath: (d: any) => d.path,
          getColor: color as any, getWidth: 4, widthMinPixels: 3,
        }));
      }
    }

    if (stops.length) {
      arr.push(new ScatterplotLayer({
        id: 'bp-stop-halo', data: stops, pickable: false,
        getPosition: (d: MapStop) => d.pos,
        getFillColor: (d: MapStop) => [...STOP_PALETTE[d.kind], 60] as any,
        getRadius: 160, radiusMinPixels: 16, radiusMaxPixels: 50, stroked: false, filled: true, parameters: { depthTest: false },
      }));
      arr.push(new ScatterplotLayer({
        id: 'bp-stop-marker', data: stops, pickable: true,
        getPosition: (d: MapStop) => d.pos,
        getFillColor: [255, 255, 255, 240] as any,
        getLineColor: (d: MapStop) => [...STOP_PALETTE[d.kind], 255] as any,
        getRadius: 90, radiusMinPixels: 11, radiusMaxPixels: 18, lineWidthMinPixels: 2, stroked: true, filled: true, parameters: { depthTest: false },
      }));
      arr.push(new TextLayer({
        id: 'bp-stop-number', data: stops, pickable: false,
        getPosition: (d: MapStop) => d.pos,
        getText: (d: MapStop) => String(d.idx),
        getColor: (d: MapStop) => [...STOP_PALETTE[d.kind], 255] as any,
        getSize: 12, sizeUnits: 'pixels', fontWeight: 700, getAlignmentBaseline: 'center', getTextAnchor: 'middle', parameters: { depthTest: false },
      }));
    }

    return arr;
  }, [vehicles, loads, links, stops, routePath]);

  const routeFitCoords = useMemo(() => {
    if (routePath && routePath.length > 1) return routePath;
    return stops.map((s) => s.pos);
  }, [routePath, stops]);

  const allFitCoords = useMemo(() => {
    const c: [number, number][] = [];
    for (const v of vehicles) c.push([v.lon, v.lat]);
    for (const l of loads) c.push([l.lon, l.lat]);
    return c;
  }, [vehicles, loads]);

  const focused = routeFitCoords.length >= 2;
  const fitCoords = focused ? routeFitCoords : allFitCoords;

  const recenterRef = useRef<(() => void) | null>(null);
  const onRecenterReady = useCallback((fn: () => void) => { recenterRef.current = fn; }, []);
  useEffect(() => { if (focused) recenterRef.current?.(); }, [focusKey, focused]);

  const getTooltip = (info: any) => {
    const o: any = info?.object;
    if (!o) return null;
    if (o.kind && STOP_LABEL[o.kind as StopKind]) {
      return { html: `<div style="font-size:12px"><b>#${escapeHtml(o.idx)} ${escapeHtml(STOP_LABEL[o.kind as StopKind])}</b>${o.city ? `<br/>${escapeHtml(o.city)}` : ''}</div>` };
    }
    if (o.internal !== undefined && o.id) {
      return { html: `<div style="font-size:12px"><b>Load ${escapeHtml(o.id)}</b> (${o.internal ? 'internal' : 'external'})${o.city ? `<br/>${escapeHtml(place(o.city))}` : ''}${o.source ? `<br/>${escapeHtml(o.source)}` : ''}</div>` };
    }
    if (o.id && o.lon !== undefined) {
      return { html: `<div style="font-size:12px"><b>Vehicle ${escapeHtml(o.id)}</b> (idle)</div>` };
    }
    return null;
  };

  return (
    <div style={{ position: 'relative', border: '1px solid var(--border)', borderRadius: 6, overflow: 'hidden', minHeight: 0, height: '100%' }}>
      <MapView layers={layers} fitTo={{ coords: fitCoords, regionKey: focused ? `route:${focusKey}` : 'all', maxZoom: 12, focusKey }} getTooltip={getTooltip} onRecenterReady={onRecenterReady} />
    </div>
  );
}

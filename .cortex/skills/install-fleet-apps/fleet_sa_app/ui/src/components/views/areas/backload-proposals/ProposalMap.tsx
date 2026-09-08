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
import { PathStyleExtension } from '@deck.gl/extensions';
import MapView from '../map-view';
import { COLOR_VEHICLE, COLOR_VEHICLE_STROKE, COLOR_INTERNAL, COLOR_EXTERNAL, COLOR_EXTERNAL_STROKE, COLOR_LEG_EMPTY } from './constants';
import { place } from './format';
import { escapeHtml } from '@/lib/html';

export interface MapVehicle { id: string; lon: number; lat: number; }
export interface MapLoad { id: string; lon: number; lat: number; internal: boolean; city: string | null; source: string | null; }
export interface MapLink { from: [number, number]; to: [number, number]; key: string; }
export type StopKind = 'start' | 'pickup' | 'delivery' | 'end';
export interface MapStop { idx: number; kind: StopKind; pos: [number, number]; city: string | null; }
// Whether a leg between two consecutive stops earns revenue. A two-hop chain is
// empty / loaded / empty / loaded / empty, so a caller with more than three
// stops MUST declare this - otherwise every middle leg is painted as a paying
// leg and the map claims revenue on repositioning distance.
export type MapLegKind = 'empty' | 'loaded';
/** Road geometry for one leg, so a fetched route can still be coloured by kind. */
export interface MapRouteLeg { path: [number, number][]; kind: MapLegKind; }

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
  // Optional: one entry per consecutive stop pair (length stops.length - 1).
  // When omitted the legacy 3-stop behaviour applies - first leg dashed empty,
  // every later leg solid loaded.
  legKinds?: MapLegKind[];
  // Optional: per-leg road geometry. Preferred over routePath when present,
  // because a single polyline through every waypoint cannot be coloured by kind.
  routeLegs?: MapRouteLeg[];
  // Label for the final stop. Defaults to the single-hop meaning ("Next start").
  endLabel?: string;
}

// Selected route stop palette, matched to the Backload Matching map:
// start = grey, pickup = amber, delivery = green, next = Snowflake blue.
const STOP_PALETTE: Record<StopKind, [number, number, number]> = {
  start: [156, 163, 175], pickup: [245, 158, 11], delivery: [22, 163, 74], end: [41, 181, 232],
};
const STOP_LABEL: Record<StopKind, string> = { start: 'Start', pickup: 'Pickup', delivery: 'Delivery', end: 'Next start' };
// Loaded (revenue) route colour - accent blue, mirroring the Matching route.
const ROUTE_COLOR: [number, number, number] = [29, 78, 216];

export default function ProposalMap({
  vehicles, loads, links, stops, routePath, focusKey, legKinds, routeLegs, endLabel,
}: Props) {
  const layers = useMemo(() => {
    const arr: any[] = [];

    // Base estate markers, styled to match the Backload Matching map (colour,
    // radius, stroke). External offers rendered first so internal/vehicles sit
    // on top when co-located.
    const internalLoads = loads.filter((l) => l.internal);
    const externalLoads = loads.filter((l) => !l.internal);
    arr.push(new ScatterplotLayer({
      id: 'bp-loads-external', data: externalLoads,
      getPosition: (d: MapLoad) => [d.lon, d.lat],
      getFillColor: [...COLOR_EXTERNAL, 160] as any,
      getLineColor: [...COLOR_EXTERNAL_STROKE, 220] as any,
      stroked: true, lineWidthMinPixels: 1,
      getRadius: 600, radiusMinPixels: 3, radiusMaxPixels: 5, pickable: true,
    }));
    arr.push(new ScatterplotLayer({
      id: 'bp-loads-internal', data: internalLoads,
      getPosition: (d: MapLoad) => [d.lon, d.lat],
      getFillColor: [...COLOR_INTERNAL, 220] as any,
      getRadius: 800, radiusMinPixels: 4, radiusMaxPixels: 6, pickable: true,
    }));
    arr.push(new ScatterplotLayer({
      id: 'bp-all-vehicles', data: vehicles,
      getPosition: (d: MapVehicle) => [d.lon, d.lat],
      getFillColor: [...COLOR_VEHICLE, 240] as any,
      getLineColor: [...COLOR_VEHICLE_STROKE, 255] as any,
      stroked: true, lineWidthMinPixels: 1,
      getRadius: 1200, radiusMinPixels: 5, radiusMaxPixels: 9, pickable: true,
    }));

    if (links.length) {
      arr.push(new LineLayer({
        id: 'bp-links', data: links,
        getSourcePosition: (d: MapLink) => d.from,
        getTargetPosition: (d: MapLink) => d.to,
        getColor: [150, 150, 160, 70] as any, getWidth: 1,
      }));
    }

    // Route legs. Three cases, in order of fidelity:
    //  1. routeLegs - per-leg road geometry, coloured by kind. The only option
    //     that is both road-accurate AND honest about which legs earn revenue.
    //  2. routePath - one polyline through every waypoint. Road-accurate but
    //     unsplittable, so it is drawn in the loaded colour (legacy 3-stop
    //     behaviour, where only the middle leg is loaded anyway).
    //  3. straight legs between consecutive stops, coloured by legKinds when
    //     the caller supplied them.
    const kindOf = (legIdx: number): MapLegKind =>
      legKinds ? (legKinds[legIdx] ?? 'loaded') : (legIdx === 0 ? 'empty' : 'loaded');
    const emptyStyle = {
      getColor: [...COLOR_LEG_EMPTY, 220] as any, getWidth: 4, widthMinPixels: 3,
      getDashArray: [10, 6] as any, dashJustified: true,
      extensions: [new PathStyleExtension({ dash: true })],
      parameters: { depthTest: false },
    };
    const loadedStyle = {
      getColor: ROUTE_COLOR as any, getWidth: 5, widthMinPixels: 3,
      parameters: { depthTest: false },
    };

    if (routeLegs && routeLegs.length) {
      routeLegs.forEach((leg, i) => {
        if (leg.path.length < 2) return;
        arr.push(new PathLayer({
          id: `bp-route-leg-${i}`, data: [{ path: leg.path }], getPath: (d: any) => d.path,
          ...(leg.kind === 'empty' ? emptyStyle : loadedStyle),
        }));
      });
    } else if (stops.length >= 2) {
      // Empty legs always come from the straight geometry: a single polyline
      // through every waypoint cannot be split, so it can only stand in for the
      // loaded legs. Legacy callers have exactly one empty leg (start->pickup),
      // which is why this reproduces their dashed repositioning cue unchanged.
      for (let i = 0; i < stops.length - 1; i++) {
        if (kindOf(i) !== 'empty') continue;
        arr.push(new PathLayer({
          id: `bp-leg-empty-${i}`,
          data: [{ path: [stops[i].pos, stops[i + 1].pos] }], getPath: (d: any) => d.path,
          ...emptyStyle,
        }));
      }
      if (routePath && routePath.length > 1) {
        arr.push(new GeoJsonLayer({
          id: 'bp-route', data: { type: 'Feature', geometry: { type: 'LineString', coordinates: routePath }, properties: {} } as any,
          getLineColor: ROUTE_COLOR as any, getLineWidth: 5, lineWidthMinPixels: 3, getFillColor: [0, 0, 0, 0],
        }));
      } else {
        for (let i = 0; i < stops.length - 1; i++) {
          if (kindOf(i) !== 'loaded') continue;
          arr.push(new PathLayer({
            id: `bp-leg-loaded-${i}`,
            data: [{ path: [stops[i].pos, stops[i + 1].pos] }], getPath: (d: any) => d.path,
            ...loadedStyle,
          }));
        }
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
  }, [vehicles, loads, links, stops, routePath, routeLegs, legKinds]);

  const routeFitCoords = useMemo(() => {
    if (routeLegs && routeLegs.length) {
      const c: [number, number][] = [];
      for (const leg of routeLegs) for (const p of leg.path) c.push(p);
      if (c.length >= 2) return c;
    }
    if (routePath && routePath.length > 1) return routePath;
    return stops.map((s) => s.pos);
  }, [routeLegs, routePath, stops]);

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
      const label = o.kind === 'end' ? (endLabel ?? STOP_LABEL.end) : STOP_LABEL[o.kind as StopKind];
      return { html: `<div style="font-size:12px"><b>#${escapeHtml(o.idx)} ${escapeHtml(label)}</b>${o.city ? `<br/>${escapeHtml(place(o.city))}` : ''}</div>` };
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

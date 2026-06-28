// DeckGL map of offer pickup points + selected-offer route overlay.
// When an offer is selected the map adds three layers on top of the basemap
// and the offers scatterplot: a PathLayer for the pickup->dropoff route
// (solid for cache/live, dashed straight-line while the live fetch is in
// flight), a green pickup marker, and a red dropoff marker. Camera is
// driven by useFitMap keyed on the selected OFFER_ID so selecting an offer
// flies to its bbox and clearing the selection flies back to the full set.

import { useMemo } from 'react';
import DeckGL from '@deck.gl/react';
import { ScatterplotLayer, PathLayer } from '@deck.gl/layers';
import { PathStyleExtension } from '@deck.gl/extensions';
import type { Offer } from './types';
import type { SelectedOfferRoute } from './sql';
import { SOURCE_COLOR } from './constants';
import { cartoBasemap } from './helpers';
import { useFitMap } from '../../shared/useFitMap';
import type { LngLat } from '../../shared/mapFit';

interface Props {
  rows: Offer[];
  selected: Offer | null;
  onSelect: (offer: Offer) => void;
  route: SelectedOfferRoute;
}

function isFiniteCoord(n: unknown): n is number {
  return typeof n === 'number' && Number.isFinite(n);
}

export default function OffersMap({ rows, selected, onSelect, route }: Props) {
  const pickupCoord: LngLat | null = selected && isFiniteCoord(selected.PICKUP_LON) && isFiniteCoord(selected.PICKUP_LAT)
    ? [selected.PICKUP_LON, selected.PICKUP_LAT]
    : null;
  const dropoffCoord: LngLat | null = selected && isFiniteCoord(selected.DROPOFF_LON) && isFiniteCoord(selected.DROPOFF_LAT)
    ? [selected.DROPOFF_LON, selected.DROPOFF_LAT]
    : null;

  // Coords driving useFitMap. When an offer is selected we fit to the route
  // bbox (route polyline + endpoints), falling back to just the endpoints
  // while the live fetch is in flight or on ORS failure. With no selection
  // we fit to all visible pickup points.
  const fitCoords: LngLat[] = useMemo(() => {
    if (selected) {
      const out: LngLat[] = [];
      if (route.coords) out.push(...route.coords);
      if (pickupCoord) out.push(pickupCoord);
      if (dropoffCoord) out.push(dropoffCoord);
      return out;
    }
    return rows
      .filter(o => isFiniteCoord(o.PICKUP_LON) && isFiniteCoord(o.PICKUP_LAT))
      .map(o => [o.PICKUP_LON, o.PICKUP_LAT] as LngLat);
  }, [selected, route.coords, pickupCoord, dropoffCoord, rows]);

  const { containerRef, viewState, onViewStateChange } = useFitMap(fitCoords, {
    regionKey: selected?.OFFER_ID ?? '_all',
    padding: 32,
    fallback: { longitude: -122.4, latitude: 37.7, zoom: 4 },
  });

  const selectedSourceColor: [number, number, number] = selected
    ? (SOURCE_COLOR[selected.SOURCE] || [55, 119, 244])
    : [55, 119, 244];

  const layers = useMemo(() => {
    const base: any[] = [
      cartoBasemap(),
      new ScatterplotLayer({
        id: 'fx-offers',
        data: rows,
        getPosition: (o: Offer) => [o.PICKUP_LON, o.PICKUP_LAT],
        getRadius: 6,
        radiusUnits: 'pixels',
        getFillColor: (o: Offer) => {
          const c = SOURCE_COLOR[o.SOURCE] || [128, 128, 128];
          const alpha = o.STATUS === 'OPEN' ? 220 : 90;
          return [c[0], c[1], c[2], alpha];
        },
        getLineColor: (o: Offer) => {
          if (o.OFFER_ID === selected?.OFFER_ID) return [0, 0, 0, 255];
          if (o.TRUST_BADGE === 'RED') return [220, 38, 38, 255];
          if (o.TRUST_BADGE === 'YELLOW') return [202, 138, 4, 255];
          return [255, 255, 255, 200];
        },
        lineWidthMinPixels: 1,
        stroked: true,
        pickable: true,
        onClick: ({ object }: any) => { if (object) onSelect(object as Offer); },
        updateTriggers: { getLineColor: [selected?.OFFER_ID] },
      }),
    ];

    if (selected && pickupCoord && dropoffCoord) {
      // Path: prefer the resolved road geometry; while the live fetch is in
      // flight, render a dashed straight pickup->dropoff segment so the user
      // immediately sees the lane direction. On ORS failure (no coords, not
      // loading) we draw nothing here - the two endpoint markers below still
      // anchor the visual.
      if (route.coords && route.coords.length >= 2) {
        base.push(new PathLayer({
          id: 'fx-selected-route',
          data: [{ path: route.coords }],
          getPath: (d: any) => d.path,
          getColor: [selectedSourceColor[0], selectedSourceColor[1], selectedSourceColor[2], 230],
          getWidth: 5,
          widthUnits: 'pixels',
          capRounded: true,
          jointRounded: true,
          parameters: { depthTest: false },
        }));
      } else if (route.loading) {
        base.push(new PathLayer({
          id: 'fx-selected-route-pending',
          data: [{ path: [pickupCoord, dropoffCoord] }],
          getPath: (d: any) => d.path,
          getColor: [selectedSourceColor[0], selectedSourceColor[1], selectedSourceColor[2], 180],
          getWidth: 4,
          widthUnits: 'pixels',
          getDashArray: [4, 3],
          extensions: [new PathStyleExtension({ dash: true })],
          parameters: { depthTest: false },
        }));
      }
      base.push(new ScatterplotLayer({
        id: 'fx-selected-pickup',
        data: [pickupCoord],
        getPosition: (d: LngLat) => d,
        getRadius: 10,
        radiusUnits: 'pixels',
        getFillColor: [22, 163, 74, 230],
        getLineColor: [255, 255, 255, 255],
        lineWidthMinPixels: 2,
        stroked: true,
        parameters: { depthTest: false },
      }));
      base.push(new ScatterplotLayer({
        id: 'fx-selected-dropoff',
        data: [dropoffCoord],
        getPosition: (d: LngLat) => d,
        getRadius: 10,
        radiusUnits: 'pixels',
        getFillColor: [220, 38, 38, 230],
        getLineColor: [255, 255, 255, 255],
        lineWidthMinPixels: 2,
        stroked: true,
        parameters: { depthTest: false },
      }));
    }

    return base;
  }, [rows, selected, onSelect, route.coords, route.loading, pickupCoord, dropoffCoord, selectedSourceColor]);

  return (
    <div
      ref={containerRef}
      style={{ position: 'relative', border: '1px solid #e5e7eb', borderRadius: 6, overflow: 'hidden', background: '#f3f4f6' }}
    >
      <DeckGL
        viewState={viewState}
        onViewStateChange={onViewStateChange}
        controller={true}
        layers={layers}
        style={{ position: 'relative' }}
      />
    </div>
  );
}

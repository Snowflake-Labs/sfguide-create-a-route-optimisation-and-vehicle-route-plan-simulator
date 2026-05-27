// DeckGL map of offer pickup points. Future enrichment: round-trip polyline,
// reachability isochrone polygon, lane-density heatmap — each adds one
// optional layer here behind a feature flag.

import { useMemo } from 'react';
import DeckGL from '@deck.gl/react';
import { ScatterplotLayer } from '@deck.gl/layers';
import type { Offer } from './types';
import { SOURCE_COLOR } from './constants';
import { cartoBasemap } from './helpers';

interface Props {
  rows: Offer[];
  selected: Offer | null;
  onSelect: (offer: Offer) => void;
}

export default function OffersMap({ rows, selected, onSelect }: Props) {
  const initialView = useMemo(() => {
    if (!rows.length) return { longitude: -122.4, latitude: 37.7, zoom: 4 };
    const lons = rows.map(o => o.PICKUP_LON).filter(n => Number.isFinite(n));
    const lats = rows.map(o => o.PICKUP_LAT).filter(n => Number.isFinite(n));
    const lon = lons.reduce((a, b) => a + b, 0) / lons.length;
    const lat = lats.reduce((a, b) => a + b, 0) / lats.length;
    return { longitude: lon, latitude: lat, zoom: 5 };
  }, [rows]);

  const layers = useMemo(() => [
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
    }),
  ], [rows, selected, onSelect]);

  return (
    <div style={{ position: 'relative', border: '1px solid #e5e7eb', borderRadius: 6, overflow: 'hidden', background: '#f3f4f6' }}>
      <DeckGL initialViewState={initialView} controller={true} layers={layers} style={{ position: 'relative' }} />
    </div>
  );
}

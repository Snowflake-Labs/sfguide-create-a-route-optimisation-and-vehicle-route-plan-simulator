// Thin wrapper around shared/MapView that provides a default San Francisco
// view state and consistent dark-style settings. All emergency pages import
// from here so basemap/colors stay consistent.

import { useMemo } from 'react';
import MapView from '../../shared/MapView';
import type { Layer } from '@deck.gl/core';

const SF_VIEW = {
  longitude: -122.43,
  latitude:  37.77,
  zoom:      11.5,
  pitch:     0,
  bearing:   0,
};

interface Props {
  layers: Layer[];
  fitCoords?: [number, number][];
  pitch?: number;
  height?: number | string;
  getTooltip?: (info: any) => any;
  onClick?: (info: any) => void;
  regionKey?: string;
}

export default function EmergencyMap({
  layers,
  fitCoords,
  pitch,
  height = '100%',
  getTooltip,
  onClick,
  regionKey,
}: Props) {
  const fallback = useMemo(
    () => ({ ...SF_VIEW, ...(pitch !== undefined ? { pitch } : {}) }),
    [pitch]
  );

  return (
    <div
      style={{
        position: 'relative',
        height,
        width: '100%',
        borderRadius: 8,
        overflow: 'hidden',
        border: '1px solid var(--border, #ddd)',
      }}
    >
      <MapView
        layers={layers}
        fallbackViewState={fallback}
        fitTo={fitCoords && fitCoords.length ? { coords: fitCoords, regionKey, padding: 60 } : undefined}
        getTooltip={getTooltip}
        onClick={onClick}
      />
    </div>
  );
}

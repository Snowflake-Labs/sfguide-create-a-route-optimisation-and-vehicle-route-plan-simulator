import React, { useState, useMemo, useCallback, useEffect } from 'react';
import Map from 'react-map-gl/maplibre';
import DeckGL from '@deck.gl/react';
import { PathLayer, ScatterplotLayer } from '@deck.gl/layers';
import { H3HexagonLayer } from '@deck.gl/geo-layers';
import { useRoutes } from '../hooks/useData';
import type { MapZoomTarget } from '../hooks/useData';
import type { RouteData, CityConfig, MapMode, HexMatrixData, StatusFilter } from '../types';
import 'maplibre-gl/dist/maplibre-gl.css';

const BASEMAP: any = {
  version: 8,
  sources: {
    'carto-dark': {
      type: 'raster',
      tiles: [
        'https://a.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}@2x.png',
        'https://b.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}@2x.png',
        'https://c.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}@2x.png',
        'https://d.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}@2x.png',
      ],
      tileSize: 256,
      attribution: '&copy; OpenStreetMap &copy; CARTO',
    },
  },
  layers: [
    { id: 'carto-dark-layer', type: 'raster', source: 'carto-dark', minzoom: 0, maxzoom: 22 },
  ],
};

interface Props {
  city: string;
  cityConfig: CityConfig;
  mapMode: MapMode;
  onMapModeChange: (mode: MapMode) => void;
  statusFilter: StatusFilter;
  mapZoomTarget?: MapZoomTarget | null;
  onMapZoomComplete?: () => void;
}

export default function FleetMap({ city, cityConfig, mapMode, onMapModeChange, statusFilter, mapZoomTarget, onMapZoomComplete }: Props) {
  const { routes, loading } = useRoutes(city, statusFilter);
  const [viewState, setViewState] = useState({
    longitude: cityConfig.longitude,
    latitude: cityConfig.latitude,
    zoom: cityConfig.zoom,
    pitch: 0,
    bearing: 0,
  });
  const [heatData, setHeatData] = useState<any[]>([]);
  const [heatLoading, setHeatLoading] = useState(false);
  const [matrixData, setMatrixData] = useState<HexMatrixData[]>([]);
  const [matrixLoading, setMatrixLoading] = useState(false);

  useEffect(() => {
    setViewState((prev) => ({
      ...prev,
      longitude: cityConfig.longitude,
      latitude: cityConfig.latitude,
      zoom: cityConfig.zoom,
    }));
  }, [cityConfig]);

  useEffect(() => {
    if (!mapZoomTarget) return;
    setViewState((prev) => ({
      ...prev,
      longitude: mapZoomTarget.center_lon,
      latitude: mapZoomTarget.center_lat,
      zoom: mapZoomTarget.zoom,
      pitch: 0,
      bearing: 0,
    }));
    if (onMapZoomComplete) onMapZoomComplete();
  }, [mapZoomTarget, onMapZoomComplete]);

  useEffect(() => {
    if (mapMode !== 'heatmap') return;
    setHeatLoading(true);
    fetch(`/api/hex-activity?city=${encodeURIComponent(city)}`)
      .then((r) => r.json())
      .then((rows) => {
        setHeatData(rows.map((r: any) => ({
          hex_id: r.HEX_ID,
          count: Number(r.COUNT || 0),
          lat: Number(r.LAT || 0),
          lon: Number(r.LON || 0),
        })));
        setHeatLoading(false);
      })
      .catch(() => setHeatLoading(false));
  }, [city, mapMode]);

  useEffect(() => {
    if (mapMode !== 'matrix') return;
    setMatrixLoading(true);
    fetch(`/api/hex-matrix?city=${encodeURIComponent(city)}`)
      .then((r) => r.json())
      .then((rows) => {
        setMatrixData(rows.map((r: any) => ({
          hex_id: r.HEX_ID,
          delivery_count: Number(r.DELIVERY_COUNT || 0),
          avg_distance_km: Number(r.AVG_DISTANCE_KM || 0),
          avg_duration_mins: Number(r.AVG_DURATION_MINS || 0),
          avg_speed_kmh: Number(r.AVG_SPEED_KMH || 0),
          unique_couriers: Number(r.UNIQUE_COURIERS || 0),
          unique_restaurants: Number(r.UNIQUE_RESTAURANTS || 0),
          lat: Number(r.LAT || 0),
          lon: Number(r.LON || 0),
        })));
        setMatrixLoading(false);
      })
      .catch(() => setMatrixLoading(false));
  }, [city, mapMode]);

  const routesWithCoords = useMemo(
    () => routes.filter((r) => r.coordinates.length > 1),
    [routes]
  );

  const pathLayer = useMemo(
    () =>
      new PathLayer<RouteData>({
        id: 'route-paths',
        data: routesWithCoords,
        pickable: true,
        getPath: (d) => d.coordinates,
        getColor: (d) => d.color,
        getWidth: 3,
        widthMinPixels: 2,
        widthMaxPixels: 5,
        capRounded: true,
        jointRounded: true,
      }),
    [routesWithCoords]
  );

  const pickupData = useMemo(
    () =>
      routesWithCoords
        .filter((r) => r.coordinates.length > 0)
        .map((r) => ({ ...r, position: r.coordinates[0] })),
    [routesWithCoords]
  );

  const dropoffData = useMemo(
    () =>
      routesWithCoords
        .filter((r) => r.coordinates.length > 0)
        .map((r) => ({ ...r, position: r.coordinates[r.coordinates.length - 1] })),
    [routesWithCoords]
  );

  const pickupLayer = useMemo(
    () =>
      new ScatterplotLayer({
        id: 'pickups',
        data: pickupData,
        pickable: true,
        getPosition: (d: any) => d.position,
        getFillColor: (d: any) => d.color,
        getRadius: 60,
        radiusMinPixels: 4,
        radiusMaxPixels: 10,
      }),
    [pickupData]
  );

  const dropoffLayer = useMemo(
    () =>
      new ScatterplotLayer({
        id: 'dropoffs',
        data: dropoffData,
        pickable: true,
        getPosition: (d: any) => d.position,
        getFillColor: (d: any) => d.color,
        getLineColor: [255, 255, 255, 200],
        getRadius: 60,
        radiusMinPixels: 4,
        radiusMaxPixels: 10,
        stroked: true,
        lineWidthMinPixels: 2,
      }),
    [dropoffData]
  );

  const hexLayer = useMemo(
    () =>
      mapMode === 'heatmap'
        ? new H3HexagonLayer({
            id: 'hex-heat',
            data: heatData,
            pickable: true,
            filled: true,
            extruded: true,
            elevationScale: 1,
            getHexagon: (d: any) => d.hex_id,
            getFillColor: (d: any) => {
              const intensity = Math.min(d.count / 20, 1);
              return [
                Math.round(255 * intensity),
                Math.round(107 * (1 - intensity) + 180 * intensity),
                Math.round(53 * (1 - intensity)),
                200,
              ];
            },
            getElevation: (d: any) => Math.min(d.count * 50, 3000),
            opacity: 0.8,
            coverage: 0.9,
          })
        : null,
    [heatData, mapMode]
  );

  const matrixLayer = useMemo(
    () =>
      mapMode === 'matrix'
        ? new H3HexagonLayer({
            id: 'hex-matrix',
            data: matrixData,
            pickable: true,
            filled: true,
            extruded: true,
            elevationScale: 1,
            getHexagon: (d: any) => d.hex_id,
            getFillColor: (d: any) => {
              const t = Math.min(d.avg_duration_mins / 25, 1);
              return [
                Math.round(0 + 255 * t),
                Math.round(176 - 76 * t),
                Math.round(0 + 53 * t),
                200,
              ];
            },
            getElevation: (d: any) => Math.min(d.delivery_count * 80, 4000),
            opacity: 0.85,
            coverage: 0.9,
          })
        : null,
    [matrixData, mapMode]
  );

  const layers = useMemo(() => {
    if (mapMode === 'heatmap' && hexLayer) return [hexLayer];
    if (mapMode === 'matrix' && matrixLayer) return [matrixLayer];
    return [pathLayer, pickupLayer, dropoffLayer];
  }, [mapMode, hexLayer, matrixLayer, pathLayer, pickupLayer, dropoffLayer]);

  const getTooltip = useCallback(({ object, layer }: any) => {
    if (!object) return null;
    if (layer?.id === 'route-paths') {
      return {
        html: `
          <div class="tooltip-container">
            <div class="tooltip-title">Delivery Route</div>
            <div class="tooltip-row"><span class="tooltip-label">Courier</span><span class="tooltip-value">${object.courier_id}</span></div>
            <div class="tooltip-row"><span class="tooltip-label">From</span><span class="tooltip-value">${object.restaurant_name}</span></div>
            <div class="tooltip-row"><span class="tooltip-label">To</span><span class="tooltip-value">${object.customer_address}</span></div>
            <div class="tooltip-row"><span class="tooltip-label">Distance</span><span class="tooltip-value">${object.distance_km.toFixed(1)} km</span></div>
            <div class="tooltip-row"><span class="tooltip-label">ETA</span><span class="tooltip-value">${object.eta_mins.toFixed(0)} min</span></div>
            <div class="tooltip-row"><span class="tooltip-label">Status</span><span class="tooltip-value">${object.order_status}</span></div>
          </div>
        `,
        style: { background: 'transparent', border: 'none', padding: '0' },
      };
    }
    if (layer?.id === 'pickups') {
      return {
        html: `<div class="tooltip-container"><div class="tooltip-title">Pickup: ${object.restaurant_name}</div><div class="tooltip-row"><span class="tooltip-label">Courier</span><span class="tooltip-value">${object.courier_id}</span></div></div>`,
        style: { background: 'transparent', border: 'none', padding: '0' },
      };
    }
    if (layer?.id === 'dropoffs') {
      return {
        html: `<div class="tooltip-container"><div class="tooltip-title">Dropoff</div><div class="tooltip-row"><span class="tooltip-label">Address</span><span class="tooltip-value">${object.customer_address}</span></div><div class="tooltip-row"><span class="tooltip-label">Courier</span><span class="tooltip-value">${object.courier_id}</span></div></div>`,
        style: { background: 'transparent', border: 'none', padding: '0' },
      };
    }
    if (layer?.id === 'hex-heat') {
      return {
        html: `<div class="tooltip-container"><div class="tooltip-title">Delivery Activity</div><div class="tooltip-row"><span class="tooltip-label">Deliveries</span><span class="tooltip-value">${object.count}</span></div></div>`,
        style: { background: 'transparent', border: 'none', padding: '0' },
      };
    }
    if (layer?.id === 'hex-matrix') {
      return {
        html: `
          <div class="tooltip-container matrix-tooltip">
            <div class="tooltip-title">Delivery Matrix Zone</div>
            <div class="tooltip-divider"></div>
            <div class="tooltip-row"><span class="tooltip-label">Deliveries</span><span class="tooltip-value highlight">${object.delivery_count}</span></div>
            <div class="tooltip-row"><span class="tooltip-label">Avg Distance</span><span class="tooltip-value">${object.avg_distance_km} km</span></div>
            <div class="tooltip-row"><span class="tooltip-label">Avg Duration</span><span class="tooltip-value">${object.avg_duration_mins} min</span></div>
            <div class="tooltip-row"><span class="tooltip-label">Avg Speed</span><span class="tooltip-value">${object.avg_speed_kmh} km/h</span></div>
            <div class="tooltip-divider"></div>
            <div class="tooltip-row"><span class="tooltip-label">Couriers</span><span class="tooltip-value">${object.unique_couriers}</span></div>
            <div class="tooltip-row"><span class="tooltip-label">Restaurants</span><span class="tooltip-value">${object.unique_restaurants}</span></div>
            <div class="tooltip-row dim"><span class="tooltip-label">H3 Cell</span><span class="tooltip-value">${object.hex_id}</span></div>
          </div>
        `,
        style: { background: 'transparent', border: 'none', padding: '0' },
      };
    }
    return null;
  }, []);

  return (
    <div className="map-container">
      <DeckGL
        viewState={viewState}
        onViewStateChange={({ viewState: vs }: any) => setViewState(vs)}
        controller={true}
        layers={layers}
        getTooltip={getTooltip}
        getCursor={({ isDragging }: any) => isDragging ? 'grabbing' : 'grab'}
      >
        <Map mapStyle={BASEMAP} />
      </DeckGL>

      {statusFilter !== 'all' && (
        <div className="map-filter-badge">
          Showing: {statusFilter === 'active' ? 'Active Only' : statusFilter.replace('_', ' ')}
          <span className="map-filter-count">{routesWithCoords.length} routes</span>
        </div>
      )}

      <div className="map-controls">
        <button
          className={`map-control-btn ${mapMode === 'routes' ? 'active' : ''}`}
          onClick={() => onMapModeChange('routes')}
        >
          Routes
        </button>
        <button
          className={`map-control-btn ${mapMode === 'heatmap' ? 'active' : ''}`}
          onClick={() => onMapModeChange('heatmap')}
        >
          Heatmap
        </button>
        <button
          className={`map-control-btn ${mapMode === 'matrix' ? 'active' : ''}`}
          onClick={() => onMapModeChange('matrix')}
        >
          Matrix
        </button>
      </div>

      {(loading || (mapMode === 'heatmap' && heatLoading) || (mapMode === 'matrix' && matrixLoading)) && (
        <div className="map-loading">Loading fleet data...</div>
      )}

      <div className="color-legend">
        <div className="color-legend-title">
          {mapMode === 'routes' ? 'Delivery Routes' : mapMode === 'heatmap' ? 'Activity Heatmap' : 'Delivery Matrix'}
        </div>
        {mapMode === 'routes' ? (
          <>
            <div className="color-legend-item">
              <div className="color-legend-swatch" style={{ background: '#FF6B35', borderRadius: '50%' }} />
              Pickup (restaurant)
            </div>
            <div className="color-legend-item">
              <div className="color-legend-swatch" style={{ background: '#FF6B35', border: '2px solid white', borderRadius: '50%' }} />
              Dropoff (customer)
            </div>
            <div className="color-legend-item" style={{ fontSize: 10, color: 'var(--sb-text-secondary)', marginTop: 4 }}>
              Each color = unique courier
            </div>
          </>
        ) : mapMode === 'heatmap' ? (
          <>
            <div className="color-legend-item">
              <div className="color-legend-swatch" style={{ background: '#FF6B35' }} />
              Low activity
            </div>
            <div className="color-legend-item">
              <div className="color-legend-swatch" style={{ background: '#FFB899' }} />
              High activity
            </div>
          </>
        ) : (
          <>
            <div className="color-legend-item">
              <div className="color-legend-swatch" style={{ background: '#00B000' }} />
              Fast (&lt; 10 min avg)
            </div>
            <div className="color-legend-item">
              <div className="color-legend-swatch" style={{ background: '#FFB835' }} />
              Medium (~15 min avg)
            </div>
            <div className="color-legend-item">
              <div className="color-legend-swatch" style={{ background: '#FF6B35' }} />
              Slow (&gt; 20 min avg)
            </div>
            <div className="color-legend-item" style={{ fontSize: 10, color: 'var(--sb-text-secondary)', marginTop: 4 }}>
              Height = delivery volume | Hover for details
            </div>
          </>
        )}
      </div>

      <div className="map-attribution">
        <span>Powered by OpenRouteService & Overture Maps</span>
      </div>
    </div>
  );
}

import React, { useState, useMemo, useCallback, useEffect } from 'react';
import Map from 'react-map-gl/maplibre';
import DeckGL from '@deck.gl/react';
import { PathLayer, ScatterplotLayer, TextLayer } from '@deck.gl/layers';
import { H3HexagonLayer } from '@deck.gl/geo-layers';
import { useRoutes } from '../hooks/useData';
import type { MapZoomTarget } from '../hooks/useData';
import type { RouteData, CityConfig, MapMode, TravelTimeHexData, StatusFilter, MatrixResolution, MatrixSelection, ReachabilityHexData, CatchmentRestaurant, CatchmentCustomer } from '../types';
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

const CUISINE_EMOJI: Record<string, string> = {
  pizza_restaurant: '🍕',
  coffee_shop: '☕',
  cafe: '☕',
  bakery: '🥐',
  chinese_restaurant: '🥡',
  japanese_restaurant: '🍣',
  sushi_restaurant: '🍣',
  thai_restaurant: '🍜',
  vietnamese_restaurant: '🍜',
  korean_restaurant: '🍜',
  asian_restaurant: '🍜',
  mexican_restaurant: '🌮',
  burger_restaurant: '🍔',
  fast_food_restaurant: '🍟',
  italian_restaurant: '🍝',
  indian_restaurant: '🍛',
  seafood_restaurant: '🦐',
  sandwich_shop: '🥪',
  food_truck: '🚚',
  american_restaurant: '🍽️',
  chicken_restaurant: '🍗',
  vegetarian_restaurant: '🥗',
  vegan_restaurant: '🥗',
  ice_cream_shop: '🍦',
  dessert_shop: '🍰',
  bar: '🍺',
  restaurant: '🍽️',
};

function getCuisineEmoji(cuisine: string): string {
  if (!cuisine) return '📍';
  const lower = cuisine.toLowerCase();
  if (CUISINE_EMOJI[lower]) return CUISINE_EMOJI[lower];
  for (const [key, emoji] of Object.entries(CUISINE_EMOJI)) {
    if (lower.includes(key.split('_')[0])) return emoji;
  }
  return '🍽️';
}

interface Props {
  city: string;
  cityConfig: CityConfig;
  mapMode: MapMode;
  onMapModeChange: (mode: MapMode) => void;
  statusFilter: StatusFilter;
  mapZoomTarget?: MapZoomTarget | null;
  onMapZoomComplete?: () => void;
  onMatrixSelection?: (selection: MatrixSelection | null) => void;
  catchmentRestaurants?: CatchmentRestaurant[];
  catchmentCustomers?: CatchmentCustomer[];
  hoveredRestaurant?: CatchmentRestaurant | null;
}

export default function FleetMap({ city, cityConfig, mapMode, onMapModeChange, statusFilter, mapZoomTarget, onMapZoomComplete, onMatrixSelection, catchmentRestaurants, catchmentCustomers, hoveredRestaurant }: Props) {
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
  const [matrixData, setMatrixData] = useState<TravelTimeHexData[]>([]);
  const [matrixLoading, setMatrixLoading] = useState(false);
  const [matrixResolution, setMatrixResolution] = useState<MatrixResolution>(8);
  const [matrixTotalPairs, setMatrixTotalPairs] = useState(0);

  const [selectedOrigin, setSelectedOrigin] = useState<string | null>(null);
  const [reachData, setReachData] = useState<ReachabilityHexData[]>([]);
  const [reachLoading, setReachLoading] = useState(false);
  const [reachMax, setReachMax] = useState({ time: 0, dist: 0 });
  const [driveTimeLimit, setDriveTimeLimit] = useState<number>(60);
  const [originCoords, setOriginCoords] = useState({ lat: 0, lon: 0 });

  const [allRestaurants, setAllRestaurants] = useState<any[]>([]);
  const [restaurantsLoading, setRestaurantsLoading] = useState(false);

  const [layerVisibility, setLayerVisibility] = useState<Record<string, boolean>>({
    routes: true,
    pickups: true,
    dropoffs: true,
  });

  const toggleLayer = useCallback((key: string) => {
    setLayerVisibility((prev) => ({ ...prev, [key]: !prev[key] }));
  }, []);

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
    setSelectedOrigin(null);
    setReachData([]);
    if (onMatrixSelection) onMatrixSelection(null);
    fetch(`/api/matrix/travel-times?resolution=${matrixResolution}`)
      .then((r) => r.json())
      .then((data) => {
        setMatrixTotalPairs(data.total_pairs || 0);
        setMatrixData((data.hexagons || []).map((r: any) => ({
          hex_id: r.HEX_ID,
          lat: Number(r.LAT || 0),
          lon: Number(r.LON || 0),
          dest_count: Number(r.DEST_COUNT || 0),
          avg_travel_time_secs: Number(r.AVG_TRAVEL_TIME_SECS || 0),
          min_travel_time_secs: Number(r.MIN_TRAVEL_TIME_SECS || 0),
          max_travel_time_secs: Number(r.MAX_TRAVEL_TIME_SECS || 0),
          avg_distance_meters: Number(r.AVG_DISTANCE_METERS || 0),
          max_distance_meters: Number(r.MAX_DISTANCE_METERS || 0),
        })));
        setMatrixLoading(false);
      })
      .catch(() => setMatrixLoading(false));
  }, [mapMode, matrixResolution]);

  useEffect(() => {
    if (mapMode !== 'matrix') return;
    if (allRestaurants.length > 0) return;
    setRestaurantsLoading(true);
    fetch('/api/restaurants')
      .then((r) => r.json())
      .then((rows) => {
        setAllRestaurants(rows.map((r: any) => ({
          name: r.NAME,
          cuisine: r.CUISINE,
          city: r.CITY,
          lon: Number(r.LON),
          lat: Number(r.LAT),
          orders: Number(r.ORDERS || 0),
        })));
        setRestaurantsLoading(false);
      })
      .catch(() => setRestaurantsLoading(false));
  }, [mapMode]);

  useEffect(() => {
    if (!selectedOrigin || mapMode !== 'matrix') return;
    setReachLoading(true);
    fetch(`/api/matrix/reachability?origin=${encodeURIComponent(selectedOrigin)}&resolution=${matrixResolution}`)
      .then((r) => r.json())
      .then((data) => {
        const dests: ReachabilityHexData[] = (data.destinations || []).map((r: any) => ({
          hex_id: r.HEX_ID,
          lat: Number(r.LAT || 0),
          lon: Number(r.LON || 0),
          travel_time_secs: Number(r.TRAVEL_TIME_SECS || 0),
          distance_meters: Number(r.DISTANCE_METERS || 0),
        }));
        setReachData(dests);
        const maxTime = dests.reduce((m, d) => Math.max(m, d.travel_time_secs), 0);
        const maxDist = dests.reduce((m, d) => Math.max(m, d.distance_meters), 0);
        setReachMax({ time: maxTime, dist: maxDist });
        const maxMinutes = Math.ceil(maxTime / 60);
        setDriveTimeLimit((prev) => prev > maxMinutes || prev <= 1 ? maxMinutes : prev);
        setOriginCoords({ lat: Number(data.origin_lat || 0), lon: Number(data.origin_lon || 0) });
        setReachLoading(false);
      })
      .catch(() => setReachLoading(false));
  }, [selectedOrigin, matrixResolution, mapMode]);

  const handleMatrixClick = useCallback((info: any) => {
    if (mapMode !== 'matrix') return;
    if (info?.layer?.id === 'catchment-restaurants-icons' || info?.layer?.id === 'all-restaurants') {
      return;
    }
    if (!info?.object?.hex_id) return;
    const clickedHex = info.object.hex_id;
    if (clickedHex === selectedOrigin) {
      setSelectedOrigin(null);
      setReachData([]);
      if (onMatrixSelection) onMatrixSelection(null);
    } else {
      setSelectedOrigin(clickedHex);
      const hexData = matrixData.find((d) => d.hex_id === clickedHex);
      if (hexData) {
        setViewState((prev) => ({
          ...prev,
          longitude: hexData.lon,
          latitude: hexData.lat,
          zoom: matrixResolution === 7 ? 9 : matrixResolution === 8 ? 11 : 13,
          pitch: 0,
          bearing: 0,
        }));
      }
    }
  }, [mapMode, selectedOrigin, onMatrixSelection, matrixData, matrixResolution]);

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
        getFillColor: [102, 187, 106, 220],
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
        getFillColor: [66, 165, 245, 220],
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

  const matrixHexPickLayer = useMemo(
    () =>
      mapMode === 'matrix' && !selectedOrigin
        ? new H3HexagonLayer({
            id: 'hex-matrix',
            data: matrixData,
            pickable: true,
            filled: true,
            extruded: false,
            getHexagon: (d: any) => d.hex_id,
            getFillColor: [0, 0, 0, 1],
            opacity: 0.01,
            coverage: 1,
          })
        : null,
    [matrixData, mapMode, selectedOrigin]
  );

  const allRestaurantLayer = useMemo(
    () =>
      mapMode === 'matrix' && !selectedOrigin && allRestaurants.length > 0
        ? new ScatterplotLayer({
            id: 'all-restaurants',
            data: allRestaurants,
            pickable: true,
            getPosition: (d: any) => [d.lon, d.lat],
            getFillColor: [255, 255, 255, 200],
            getRadius: 50,
            radiusMinPixels: 3,
            radiusMaxPixels: 6,
          })
        : null,
    [allRestaurants, selectedOrigin, mapMode]
  );

  const originLayer = useMemo(
    () =>
      mapMode === 'matrix' && selectedOrigin
        ? new H3HexagonLayer({
            id: 'hex-origin',
            data: [{ hex_id: selectedOrigin }],
            pickable: true,
            filled: true,
            extruded: false,
            getHexagon: (d: any) => d.hex_id,
            getFillColor: [0, 0, 0, 0],
            getLineColor: [255, 107, 53, 255],
            getLineWidth: 3,
            lineWidthMinPixels: 3,
            stroked: true,
            opacity: 1,
            coverage: 1,
          })
        : null,
    [selectedOrigin, mapMode]
  );

  const filteredReachData = useMemo(() => {
    const limitSecs = driveTimeLimit * 60;
    return reachData.filter((d) => d.travel_time_secs <= limitSecs);
  }, [reachData, driveTimeLimit]);

  useEffect(() => {
    if (!selectedOrigin || !onMatrixSelection) return;
    if (filteredReachData.length === 0 && reachData.length === 0) return;
    const maxTime = filteredReachData.reduce((m, d) => Math.max(m, d.travel_time_secs), 0);
    const maxDist = filteredReachData.reduce((m, d) => Math.max(m, d.distance_meters), 0);
    onMatrixSelection({
      origin_hex: selectedOrigin,
      origin_lat: originCoords.lat,
      origin_lon: originCoords.lon,
      resolution: matrixResolution,
      destinations: filteredReachData,
      max_travel_time_secs: maxTime,
      max_distance_meters: maxDist,
    });
  }, [filteredReachData, selectedOrigin]);

  const reachLayer = useMemo(
    () =>
      mapMode === 'matrix' && selectedOrigin && filteredReachData.length > 0
        ? new H3HexagonLayer({
            id: 'hex-reach',
            data: filteredReachData,
            pickable: true,
            filled: true,
            extruded: false,
            getHexagon: (d: any) => d.hex_id,
            getFillColor: (d: any) => {
              const maxT = driveTimeLimit * 60 || 1;
              const t = Math.min(d.travel_time_secs / maxT, 1);
              return [
                Math.round(41 + 214 * t),
                Math.round(181 - 81 * t),
                Math.round(232 - 179 * t),
                160,
              ];
            },
            opacity: 0.7,
            coverage: 1,
            updateTriggers: {
              getFillColor: [driveTimeLimit],
            },
          })
        : null,
    [filteredReachData, driveTimeLimit, selectedOrigin, mapMode]
  );

  const nearbyRestaurants = useMemo(() => {
    if (!selectedOrigin || !catchmentRestaurants || catchmentRestaurants.length === 0) return [];
    return catchmentRestaurants.map((r) => ({
      ...r,
      emoji: getCuisineEmoji(r.cuisine),
    }));
  }, [catchmentRestaurants, selectedOrigin]);

  const restaurantIconLayer = useMemo(
    () =>
      mapMode === 'matrix' && selectedOrigin && nearbyRestaurants.length > 0
        ? new TextLayer({
            id: 'catchment-restaurants-icons',
            data: nearbyRestaurants,
            pickable: true,
            getPosition: (d: any) => [d.lon, d.lat],
            getText: (d: any) => d.emoji,
            getSize: (d: any) =>
              hoveredRestaurant && d.name === hoveredRestaurant.name ? 28 : 20,
            getColor: [255, 255, 255, 255],
            fontFamily: 'Apple Color Emoji, Segoe UI Emoji, Noto Color Emoji, sans-serif',
            fontSettings: { sdf: false },
            billboard: true,
            sizeScale: 1,
            sizeUnits: 'pixels' as any,
            updateTriggers: {
              getSize: [hoveredRestaurant?.name],
            },
          })
        : null,
    [nearbyRestaurants, selectedOrigin, mapMode, hoveredRestaurant]
  );

  const layers = useMemo(() => {
    if (mapMode === 'heatmap' && hexLayer) return [hexLayer];
    if (mapMode === 'matrix') {
      const result: any[] = [];
      if (selectedOrigin) {
        if (reachLayer) result.push(reachLayer);
        if (originLayer) result.push(originLayer);
        if (restaurantIconLayer) result.push(restaurantIconLayer);
      } else {
        if (matrixHexPickLayer) result.push(matrixHexPickLayer);
        if (allRestaurantLayer) result.push(allRestaurantLayer);
      }
      return result;
    }
    const routeLayers: any[] = [];
    if (layerVisibility.routes) routeLayers.push(pathLayer);
    if (layerVisibility.pickups) routeLayers.push(pickupLayer);
    if (layerVisibility.dropoffs) routeLayers.push(dropoffLayer);
    return routeLayers;
  }, [mapMode, hexLayer, matrixHexPickLayer, allRestaurantLayer, originLayer, reachLayer, pathLayer, pickupLayer, dropoffLayer, selectedOrigin, restaurantIconLayer, layerVisibility]);

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
      const avgMins = (object.avg_travel_time_secs / 60).toFixed(1);
      return {
        html: `
          <div class="tooltip-container matrix-tooltip">
            <div class="tooltip-title">Click to select origin</div>
            <div class="tooltip-divider"></div>
            <div class="tooltip-row"><span class="tooltip-label">Destinations</span><span class="tooltip-value highlight">${object.dest_count}</span></div>
            <div class="tooltip-row"><span class="tooltip-label">Avg Travel Time</span><span class="tooltip-value">${avgMins} min</span></div>
            <div class="tooltip-row dim"><span class="tooltip-label">H3</span><span class="tooltip-value">${object.hex_id}</span></div>
          </div>
        `,
        style: { background: 'transparent', border: 'none', padding: '0' },
      };
    }
    if (layer?.id === 'all-restaurants') {
      return {
        html: `
          <div class="tooltip-container matrix-tooltip">
            <div class="tooltip-title">${getCuisineEmoji(object.cuisine)} ${object.name}</div>
            <div class="tooltip-row"><span class="tooltip-label">Cuisine</span><span class="tooltip-value">${(object.cuisine || '').replace(/_/g, ' ')}</span></div>
            <div class="tooltip-row"><span class="tooltip-label">Orders</span><span class="tooltip-value">${object.orders}</span></div>
            <div class="tooltip-row"><span class="tooltip-label">City</span><span class="tooltip-value">${object.city}</span></div>
          </div>
        `,
        style: { background: 'transparent', border: 'none', padding: '0' },
      };
    }
    if (layer?.id === 'hex-origin') {
      return {
        html: `
          <div class="tooltip-container matrix-tooltip">
            <div class="tooltip-title">Selected Origin</div>
            <div class="tooltip-row"><span class="tooltip-label">Reachable</span><span class="tooltip-value highlight">${reachData.length} hexagons</span></div>
            <div class="tooltip-row dim"><span class="tooltip-label">H3</span><span class="tooltip-value">${object.hex_id}</span></div>
            <div class="tooltip-row dim" style="margin-top:4px"><span class="tooltip-label">Click to deselect</span></div>
          </div>
        `,
        style: { background: 'transparent', border: 'none', padding: '0' },
      };
    }
    if (layer?.id === 'hex-reach') {
      const mins = (object.travel_time_secs / 60).toFixed(1);
      const km = (object.distance_meters / 1000).toFixed(1);
      return {
        html: `
          <div class="tooltip-container matrix-tooltip">
            <div class="tooltip-title">Reachable Destination</div>
            <div class="tooltip-divider"></div>
            <div class="tooltip-row"><span class="tooltip-label">Travel Time</span><span class="tooltip-value highlight">${mins} min</span></div>
            <div class="tooltip-row"><span class="tooltip-label">Distance</span><span class="tooltip-value">${km} km</span></div>
            <div class="tooltip-row dim"><span class="tooltip-label">H3</span><span class="tooltip-value">${object.hex_id}</span></div>
          </div>
        `,
        style: { background: 'transparent', border: 'none', padding: '0' },
      };
    }
    if (layer?.id === 'catchment-restaurants-icons') {
      return {
        html: `
          <div class="tooltip-container matrix-tooltip">
            <div class="tooltip-title">${object.emoji} ${object.name}</div>
            <div class="tooltip-divider"></div>
            <div class="tooltip-row"><span class="tooltip-label">Cuisine</span><span class="tooltip-value">${(object.cuisine || '').replace(/_/g, ' ')}</span></div>
            <div class="tooltip-row"><span class="tooltip-label">Drive Time</span><span class="tooltip-value highlight">${object.drive_mins} min</span></div>
            <div class="tooltip-row"><span class="tooltip-label">Orders</span><span class="tooltip-value">${object.orders}</span></div>
            ${object.active > 0 ? `<div class="tooltip-row"><span class="tooltip-label">Active</span><span class="tooltip-value highlight">${object.active}</span></div>` : ''}
          </div>
        `,
        style: { background: 'transparent', border: 'none', padding: '0' },
      };
    }
    return null;
  }, [reachData.length, hoveredRestaurant]);

  const clearSelection = useCallback(() => {
    setSelectedOrigin(null);
    setReachData([]);
    if (onMatrixSelection) onMatrixSelection(null);
  }, [onMatrixSelection]);

  return (
    <div className="map-container">
      <DeckGL
        viewState={viewState}
        onViewStateChange={({ viewState: vs }: any) => setViewState(vs)}
        controller={true}
        layers={layers}
        getTooltip={getTooltip}
        onClick={handleMatrixClick}
        getCursor={({ isDragging, isHovering }: any) => {
          if (isDragging) return 'grabbing';
          if (mapMode === 'matrix' && isHovering) return 'pointer';
          return 'grab';
        }}
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

      {mapMode === 'routes' && (
        <div className="layer-toggle-panel">
          <div className="layer-toggle-title">Layers</div>
          {[
            { key: 'routes', label: 'Routes', color: '#FF6B35' },
            { key: 'pickups', label: 'Pickups', color: '#66BB6A' },
            { key: 'dropoffs', label: 'Dropoffs', color: '#42A5F5' },
          ].map((layer) => (
            <label key={layer.key} className="layer-toggle-item">
              <input
                type="checkbox"
                checked={layerVisibility[layer.key]}
                onChange={() => toggleLayer(layer.key)}
                className="layer-toggle-checkbox"
              />
              <span className="layer-toggle-swatch" style={{ background: layer.color }} />
              <span className="layer-toggle-label">{layer.label}</span>
            </label>
          ))}
        </div>
      )}

      {mapMode === 'matrix' && (
        <div className="matrix-resolution-selector">
          <span className="matrix-res-label">Resolution</span>
          {([7, 8, 9] as MatrixResolution[]).map((r) => (
            <button
              key={r}
              className={`matrix-res-btn ${matrixResolution === r ? 'active' : ''}`}
              onClick={() => { setMatrixResolution(r); clearSelection(); }}
            >
              Res {r}
            </button>
          ))}
          <span className="matrix-res-info">{matrixData.length} origins &middot; {matrixTotalPairs.toLocaleString()} pairs</span>
        </div>
      )}

      {mapMode === 'matrix' && selectedOrigin && (
        <div className="matrix-origin-info">
          <div className="matrix-origin-header">
            <span className="matrix-origin-title">Origin Selected</span>
            <button className="matrix-origin-clear" onClick={clearSelection}>&times;</button>
          </div>
          <div className="matrix-origin-hex">{selectedOrigin}</div>
          {reachLoading ? (
            <div className="matrix-origin-loading">Loading reachability...</div>
          ) : (
            <>
              {reachMax.time > 0 && (
                <div className="matrix-drive-slider">
                  <div className="matrix-drive-slider-header">
                    <span className="matrix-drive-slider-label">Drive Time Limit</span>
                    <span className="matrix-drive-slider-value">{driveTimeLimit} min</span>
                  </div>
                  <input
                    type="range"
                    className="matrix-drive-range"
                    min={1}
                    max={Math.ceil(reachMax.time / 60)}
                    value={driveTimeLimit}
                    onChange={(e) => setDriveTimeLimit(Number(e.target.value))}
                  />
                  <div className="matrix-drive-slider-ticks">
                    <span>1 min</span>
                    <span>{Math.ceil(reachMax.time / 60)} min</span>
                  </div>
                </div>
              )}
              <div className="matrix-origin-stat">
                <span>{filteredReachData.length}</span> of {reachData.length} hexagons within {driveTimeLimit} min
              </div>
            </>
          )}
        </div>
      )}

      {(loading || (mapMode === 'heatmap' && heatLoading) || (mapMode === 'matrix' && (matrixLoading || restaurantsLoading))) && (
        <div className="map-loading">Loading fleet data...</div>
      )}

      <div className="color-legend">
        <div className="color-legend-title">
          {mapMode === 'routes' ? 'Delivery Routes' : mapMode === 'heatmap' ? 'Activity Heatmap' : selectedOrigin ? 'Reachability from Origin' : `Restaurants (Res ${matrixResolution})`}
        </div>
        {mapMode === 'routes' ? (
          <>
            <div className="color-legend-item">
              <div className="color-legend-swatch" style={{ background: '#66BB6A', borderRadius: '50%' }} />
              Pickup (restaurant)
            </div>
            <div className="color-legend-item">
              <div className="color-legend-swatch" style={{ background: '#42A5F5', border: '2px solid white', borderRadius: '50%' }} />
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
        ) : selectedOrigin ? (
          <>
            <div className="color-legend-item">
              <div className="color-legend-swatch" style={{ background: 'transparent', border: '2px solid #FF6B35' }} />
              Selected origin
            </div>
            <div className="color-legend-item">
              <div className="color-legend-swatch" style={{ background: 'rgb(41, 181, 232)' }} />
              Close (fast)
            </div>
            <div className="color-legend-item">
              <div className="color-legend-swatch" style={{ background: 'rgb(255, 100, 53)' }} />
              Far (slow)
            </div>
            <div className="color-legend-item" style={{ fontSize: 10, color: 'var(--sb-text-secondary)', marginTop: 4 }}>
              🍕🍔☕ = restaurants in catchment
            </div>
          </>
        ) : (
          <>
            <div className="color-legend-item">
              <div className="color-legend-swatch" style={{ background: 'white', borderRadius: '50%' }} />
              Restaurant location
            </div>
            <div className="color-legend-item" style={{ fontSize: 10, color: 'var(--sb-text-secondary)', marginTop: 4 }}>
              Click anywhere to explore drive times
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

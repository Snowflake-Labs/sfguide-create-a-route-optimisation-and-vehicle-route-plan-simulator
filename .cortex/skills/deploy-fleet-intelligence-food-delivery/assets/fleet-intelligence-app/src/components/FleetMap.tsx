import React, { useState, useMemo, useCallback, useEffect, useRef } from 'react';
import Map from 'react-map-gl/maplibre';
import DeckGL from '@deck.gl/react';
import { PathLayer, ScatterplotLayer, GeoJsonLayer } from '@deck.gl/layers';
import { H3HexagonLayer } from '@deck.gl/geo-layers';
import { useRoutes } from '../hooks/useData';
import type { MapZoomTarget, FleetAlert } from '../hooks/useData';
import type { RouteData, CityConfig, MapMode, TravelTimeHexData, MapFilter, StatusFilter, MatrixResolution, MatrixSelection, ReachabilityHexData, CatchmentRestaurant, CatchmentCustomer, AnimatedRoute } from '../types';
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

const CUISINE_COLORS: Record<string, [number, number, number]> = {
  pizza: [255, 165, 0],
  coffee: [139, 90, 43],
  cafe: [139, 90, 43],
  bakery: [210, 180, 140],
  chinese: [220, 20, 60],
  japanese: [255, 99, 71],
  sushi: [255, 99, 71],
  thai: [255, 215, 0],
  vietnamese: [255, 215, 0],
  korean: [255, 215, 0],
  asian: [255, 215, 0],
  mexican: [0, 200, 83],
  burger: [244, 164, 96],
  fast_food: [255, 69, 0],
  italian: [60, 179, 113],
  indian: [255, 140, 0],
  seafood: [0, 191, 255],
  sandwich: [222, 184, 135],
  food_truck: [128, 128, 128],
  american: [70, 130, 180],
  chicken: [218, 165, 32],
  vegetarian: [50, 205, 50],
  vegan: [50, 205, 50],
  ice_cream: [255, 182, 193],
  dessert: [255, 105, 180],
  bar: [186, 85, 211],
};

function getCuisineColor(cuisine: string): [number, number, number] {
  if (!cuisine) return [255, 255, 255];
  const lower = cuisine.toLowerCase();
  for (const [key, color] of Object.entries(CUISINE_COLORS)) {
    if (lower.includes(key)) return color;
  }
  return [255, 255, 255];
}

function getCuisineEmoji(cuisine: string): string {
  if (!cuisine) return '📍';
  const lower = cuisine.toLowerCase();
  if (CUISINE_EMOJI[lower]) return CUISINE_EMOJI[lower];
  for (const [key, emoji] of Object.entries(CUISINE_EMOJI)) {
    if (lower.includes(key.split('_')[0])) return emoji;
  }
  return '🍽️';
}

function formatDateLabel(dateStr: string, long = false): string {
  if (!dateStr) return '?';
  const parts = dateStr.split('-');
  if (parts.length === 3) {
    const d = new Date(Number(parts[0]), Number(parts[1]) - 1, Number(parts[2]));
    if (!isNaN(d.getTime())) {
      return long
        ? d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })
        : d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
    }
  }
  return dateStr;
}

interface Props {
  city: string;
  cityConfig: CityConfig;
  mapMode: MapMode;
  onMapModeChange: (mode: MapMode) => void;
  statusFilter: StatusFilter;
  mapFilter: MapFilter;
  onClearMapFilter?: () => void;
  mapZoomTarget?: MapZoomTarget | null;
  onMapZoomComplete?: () => void;
  onMatrixSelection?: (selection: MatrixSelection | null) => void;
  catchmentRestaurants?: CatchmentRestaurant[];
  catchmentCustomers?: CatchmentCustomer[];
  hoveredRestaurant?: CatchmentRestaurant | null;
  refreshKey?: number;
  floodAlerts?: FleetAlert[];
}

export default function FleetMap({ city, cityConfig, mapMode, onMapModeChange, statusFilter, mapFilter, onClearMapFilter, mapZoomTarget, onMapZoomComplete, onMatrixSelection, catchmentRestaurants, catchmentCustomers, hoveredRestaurant, refreshKey = 0, floodAlerts = [] }: Props) {
  const [availableDates, setAvailableDates] = useState<{date: string; count: number}[]>([]);
  const [selectedDateIdx, setSelectedDateIdx] = useState<number>(-1);
  const selectedDate = selectedDateIdx >= 0 && selectedDateIdx < availableDates.length ? availableDates[selectedDateIdx].date : '';
  const { routes, loading } = useRoutes(city, mapFilter, selectedDate, refreshKey);
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

  const [animatedRoute, setAnimatedRoute] = useState<AnimatedRoute | null>(null);
  const [routeLoading, setRouteLoading] = useState(false);
  const [routeLoadingMsg, setRouteLoadingMsg] = useState('');
  const [animProgress, setAnimProgress] = useState(0);
  const animRef = useRef<number | null>(null);
  const animStartRef = useRef<number>(0);
  const animProgressRef = useRef(0);
  const ANIM_DURATION_MS = 8000;
  const ANIM_FPS = 20;

  const [layerVisibility, setLayerVisibility] = useState<Record<string, boolean>>({
    routes: true,
    pickups: true,
    dropoffs: true,
    couriers: true,
  });

  const [selectedHour, setSelectedHour] = useState<number>(-1);
  const [availableHours, setAvailableHours] = useState<{hour: number; activeOrders: number}[]>([]);
  const [courierPositions, setCourierPositions] = useState<any[]>([]);
  const [couriersLoading, setCouriersLoading] = useState(false);

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
    fetch(`/api/routes/dates?city=${encodeURIComponent(city)}`)
      .then((r) => r.json())
      .then((dates) => {
        setAvailableDates(dates);
        setSelectedDateIdx(dates.length > 0 ? dates.length - 1 : -1);
      })
      .catch(() => setAvailableDates([]));
  }, [city]);

  useEffect(() => {
    if (!selectedDate) { setAvailableHours([]); setSelectedHour(-1); return; }
    fetch(`/api/routes/hours?city=${encodeURIComponent(city)}&date=${selectedDate}`)
      .then((r) => r.json())
      .then((hours: any[]) => { setAvailableHours(hours); setSelectedHour(-1); })
      .catch(() => setAvailableHours([]));
  }, [city, selectedDate]);

  useEffect(() => {
    if (mapMode !== 'routes' || !selectedDate) { setCourierPositions([]); return; }
    setCouriersLoading(true);
    const params = new URLSearchParams({ city, date: selectedDate });
    if (selectedHour >= 0) params.set('hour', String(selectedHour));
    fetch(`/api/routes/courier-positions?${params.toString()}`)
      .then((r) => r.json())
      .then((positions: any[]) => { setCourierPositions(positions); setCouriersLoading(false); })
      .catch(() => { setCourierPositions([]); setCouriersLoading(false); });
  }, [city, selectedDate, selectedHour, mapMode]);

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
    fetch(`/api/matrix/travel-times?resolution=${matrixResolution}&city=${encodeURIComponent(city)}`)
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
  }, [mapMode, matrixResolution, city]);

  useEffect(() => {
    if (mapMode !== 'matrix') return;
    setRestaurantsLoading(true);
    setAllRestaurants([]);
    fetch(`/api/restaurants?city=${encodeURIComponent(city)}`)
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
  }, [mapMode, city]);

  useEffect(() => {
    if (!selectedOrigin || mapMode !== 'matrix') return;
    setReachLoading(true);
    fetch(`/api/matrix/reachability?origin=${encodeURIComponent(selectedOrigin)}&resolution=${matrixResolution}&city=${encodeURIComponent(city)}`)
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
  }, [selectedOrigin, matrixResolution, mapMode, city]);

  useEffect(() => {
    if (!animatedRoute) {
      if (animRef.current) { clearInterval(animRef.current); animRef.current = null; }
      return;
    }
    animStartRef.current = performance.now();
    animProgressRef.current = 0;
    setAnimProgress(0);
    const interval = setInterval(() => {
      const elapsed = performance.now() - animStartRef.current;
      const t = Math.min(elapsed / ANIM_DURATION_MS, 1);
      animProgressRef.current = t;
      setAnimProgress(t);
      if (t >= 1) {
        clearInterval(interval);
        animRef.current = null;
      }
    }, 1000 / ANIM_FPS);
    animRef.current = interval as any;
    return () => { clearInterval(interval); animRef.current = null; };
  }, [animatedRoute]);

  const fetchRouteToRestaurant = useCallback((restaurant: CatchmentRestaurant) => {
    if (!selectedOrigin || !originCoords.lat) return;
    setRouteLoading(true);
    setRouteLoadingMsg('Connecting to routing service...');
    setAnimatedRoute(null);
    const params = new URLSearchParams({
      start_lon: String(originCoords.lon),
      start_lat: String(originCoords.lat),
      end_lon: String(restaurant.lon),
      end_lat: String(restaurant.lat),
      city: city,
      profile: 'driving-car',
    });
    fetch(`/api/matrix/directions?${params}`)
      .then(async (r) => {
        if (!r.ok) {
          const err = await r.json().catch(() => ({}));
          throw new Error(err.error || `HTTP ${r.status}`);
        }
        return r.json();
      })
      .then((data) => {
        setAnimatedRoute({ ...data, restaurant });
        setRouteLoading(false);
        setRouteLoadingMsg('');
      })
      .catch((err) => {
        console.error('Route fetch error:', err);
        setRouteLoading(false);
        setRouteLoadingMsg('');
      });
  }, [selectedOrigin, originCoords, city]);

  const handleMatrixClick = useCallback((info: any) => {
    if (mapMode !== 'matrix') return;
    if (info?.layer?.id === 'catchment-restaurants-icons') {
      const r = info.object;
      if (r && r.name) {
        fetchRouteToRestaurant(r);
      }
      return;
    }
    if (info?.layer?.id === 'all-restaurants') {
      return;
    }
    if (info?.layer?.id === 'animated-car') return;
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
  }, [mapMode, selectedOrigin, onMatrixSelection, matrixData, matrixResolution, fetchRouteToRestaurant]);

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

  const courierLayer = useMemo(
    () =>
      courierPositions.length > 0
        ? new ScatterplotLayer({
            id: 'courier-bikes',
            data: courierPositions,
            pickable: true,
            getPosition: (d: any) => [d.lon, d.lat],
            getFillColor: [255, 213, 79, 255],
            getLineColor: [255, 255, 255, 255],
            getRadius: 80,
            radiusMinPixels: 6,
            radiusMaxPixels: 14,
            stroked: true,
            lineWidthMinPixels: 2,
          })
        : null,
    [courierPositions]
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
        ? new ScatterplotLayer({
            id: 'catchment-restaurants-icons',
            data: nearbyRestaurants,
            pickable: true,
            getPosition: (d: any) => [d.lon, d.lat],
            getFillColor: (d: any) => {
              const c = getCuisineColor(d.cuisine);
              return hoveredRestaurant && d.name === hoveredRestaurant.name
                ? [255, 255, 255, 255]
                : [c[0], c[1], c[2], 230];
            },
            getLineColor: [255, 255, 255, 200],
            getRadius: (d: any) =>
              hoveredRestaurant && d.name === hoveredRestaurant.name ? 120 : 80,
            lineWidthMinPixels: 2,
            stroked: true,
            radiusMinPixels: 5,
            radiusMaxPixels: 12,
            updateTriggers: {
              getFillColor: [hoveredRestaurant?.name],
              getRadius: [hoveredRestaurant?.name],
            },
          })
        : null,
    [nearbyRestaurants, selectedOrigin, mapMode, hoveredRestaurant]
  );

  const carPosition = useMemo(() => {
    if (!animatedRoute) return null;
    const coords = animatedRoute.coordinates;
    if (!coords || coords.length < 2) return null;
    const totalLen = coords.length - 1;
    const idx = animProgress * totalLen;
    const i = Math.min(Math.floor(idx), totalLen - 1);
    const frac = idx - i;
    const lon = coords[i][0] + (coords[i + 1][0] - coords[i][0]) * frac;
    const lat = coords[i][1] + (coords[i + 1][1] - coords[i][1]) * frac;
    const bearing = Math.atan2(
      coords[Math.min(i + 1, totalLen)][0] - coords[i][0],
      coords[Math.min(i + 1, totalLen)][1] - coords[i][1]
    ) * (180 / Math.PI);
    return { lon, lat, bearing };
  }, [animatedRoute, animProgress]);

  const animatedPathData = useMemo(() => {
    if (!animatedRoute) return [];
    const coords = animatedRoute.coordinates;
    const endIdx = Math.floor(animProgress * (coords.length - 1)) + 1;
    return [{ path: coords.slice(0, Math.min(endIdx + 1, coords.length)) }];
  }, [animatedRoute, animProgress]);

  const animatedRouteLayer = useMemo(
    () =>
      animatedRoute && animatedPathData.length > 0
        ? new PathLayer({
            id: 'animated-route',
            data: animatedPathData,
            pickable: false,
            getPath: (d: any) => d.path,
            getColor: [0, 230, 118, 220],
            getWidth: 5,
            widthMinPixels: 3,
            widthMaxPixels: 8,
            capRounded: true,
            jointRounded: true,
          })
        : null,
    [animatedRoute, animatedPathData]
  );

  const routeTrailLayer = useMemo(
    () =>
      animatedRoute
        ? new PathLayer({
            id: 'route-trail',
            data: [{ path: animatedRoute.coordinates }],
            pickable: false,
            getPath: (d: any) => d.path,
            getColor: [0, 230, 118, 60],
            getWidth: 3,
            widthMinPixels: 1,
            widthMaxPixels: 4,
            capRounded: true,
            jointRounded: true,
          })
        : null,
    [animatedRoute]
  );

  const carLayer = useMemo(
    () =>
      carPosition
        ? new ScatterplotLayer({
            id: 'animated-car',
            data: [carPosition],
            pickable: true,
            getPosition: (d: any) => [d.lon, d.lat],
            getFillColor: [255, 255, 255, 255],
            getLineColor: [0, 230, 118, 255],
            getRadius: 120,
            radiusMinPixels: 7,
            radiusMaxPixels: 12,
            stroked: true,
            lineWidthMinPixels: 3,
          })
        : null,
    [carPosition]
  );

  const carFallbackLayer = useMemo(
    () =>
      carPosition
        ? new ScatterplotLayer({
            id: 'animated-car-dot',
            data: [carPosition],
            pickable: false,
            getPosition: (d: any) => [d.lon, d.lat],
            getFillColor: [0, 230, 118, 255],
            getRadius: 200,
            radiusMinPixels: 10,
            radiusMaxPixels: 16,
            stroked: false,
            opacity: 0.3,
          })
        : null,
    [carPosition]
  );

  const layers = useMemo(() => {
    if (mapMode === 'heatmap' && hexLayer) return [hexLayer];
    if (mapMode === 'matrix') {
      const result: any[] = [];
      if (selectedOrigin) {
        if (reachLayer) result.push(reachLayer);
        if (originLayer) result.push(originLayer);
        if (restaurantIconLayer) result.push(restaurantIconLayer);
        if (routeTrailLayer) result.push(routeTrailLayer);
        if (animatedRouteLayer) result.push(animatedRouteLayer);
        if (carFallbackLayer) result.push(carFallbackLayer);
        if (carLayer) result.push(carLayer);
      } else {
        if (matrixHexPickLayer) result.push(matrixHexPickLayer);
        if (allRestaurantLayer) result.push(allRestaurantLayer);
      }
      return result;
    }
    const routeLayers: any[] = [];
    const floodFeatures = floodAlerts
      .filter(a => a.type === 'flood' && a.area_geojson)
      .map(a => ({ type: 'Feature' as const, properties: { title: a.title, severity: a.severity, description: a.description, water_level: a.water_level_m, roads: a.affected_roads }, geometry: a.area_geojson }));
    if (floodFeatures.length > 0) {
      routeLayers.push(new GeoJsonLayer({
        id: 'flood-zones',
        data: { type: 'FeatureCollection', features: floodFeatures },
        getFillColor: [255, 50, 50, 60],
        getLineColor: [255, 80, 80, 200],
        getLineWidth: 2,
        lineWidthMinPixels: 2,
        pickable: true,
      }));
    }
    if (layerVisibility.routes) routeLayers.push(pathLayer);
    if (layerVisibility.pickups) routeLayers.push(pickupLayer);
    if (layerVisibility.dropoffs) routeLayers.push(dropoffLayer);
    if (layerVisibility.couriers && courierLayer) routeLayers.push(courierLayer);
    return routeLayers;
  }, [mapMode, hexLayer, matrixHexPickLayer, allRestaurantLayer, originLayer, reachLayer, pathLayer, pickupLayer, dropoffLayer, selectedOrigin, restaurantIconLayer, layerVisibility, animatedRouteLayer, routeTrailLayer, carLayer, carFallbackLayer, courierLayer, floodAlerts]);

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
            ${object.delay_reason && object.delay_reason !== 'none' ? `
            <div class="tooltip-divider"></div>
            <div class="tooltip-row"><span class="tooltip-label" style="color:#ff6b6b">Delay</span><span class="tooltip-value" style="color:#ff6b6b">${object.delay_reason}${object.flood_affected ? ' (flood zone)' : ''}</span></div>
            <div class="tooltip-row"><span class="tooltip-label" style="color:#ff6b6b">Delayed by</span><span class="tooltip-value" style="color:#ff6b6b">${object.delay_minutes} min</span></div>
            ` : ''}
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
    if (layer?.id === 'courier-bikes') {
      const etaStr = object.eta_mins > 0 ? `${object.eta_mins} min` : 'Arriving';
      const stateStr = (object.state || '').replace(/_/g, ' ');
      return {
        html: `
          <div class="tooltip-container">
            <div class="tooltip-title">🚲 Courier ${object.courier_id}</div>
            <div class="tooltip-divider"></div>
            <div class="tooltip-row"><span class="tooltip-label">Status</span><span class="tooltip-value">${stateStr}</span></div>
            <div class="tooltip-row"><span class="tooltip-label">ETA</span><span class="tooltip-value highlight">${etaStr}</span></div>
            <div class="tooltip-row"><span class="tooltip-label">Speed</span><span class="tooltip-value">${object.kmh} km/h</span></div>
            <div class="tooltip-row"><span class="tooltip-label">From</span><span class="tooltip-value">${object.restaurant_name}</span></div>
            <div class="tooltip-row"><span class="tooltip-label">To</span><span class="tooltip-value">${object.customer_address}</span></div>
          </div>
        `,
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
            <div class="tooltip-title">${getCuisineEmoji(object.cuisine)} ${object.name}</div>
            <div class="tooltip-divider"></div>
            <div class="tooltip-row"><span class="tooltip-label">Cuisine</span><span class="tooltip-value">${(object.cuisine || '').replace(/_/g, ' ')}</span></div>
            <div class="tooltip-row"><span class="tooltip-label">Drive Time</span><span class="tooltip-value highlight">${object.drive_mins} min</span></div>
            <div class="tooltip-row"><span class="tooltip-label">Orders</span><span class="tooltip-value">${object.orders}</span></div>
            ${object.active > 0 ? `<div class="tooltip-row"><span class="tooltip-label">Active</span><span class="tooltip-value highlight">${object.active}</span></div>` : ''}
            <div class="tooltip-row dim" style="margin-top:4px"><span class="tooltip-label">Click to show route</span></div>
          </div>
        `,
        style: { background: 'transparent', border: 'none', padding: '0' },
      };
    }
    if (layer?.id === 'animated-car' || layer?.id === 'animated-car-dot') {
      const r = animatedRoute?.restaurant;
      const dist = animatedRoute ? (animatedRoute.distance_meters / 1000).toFixed(1) : '?';
      const dur = animatedRoute ? Math.round(animatedRoute.duration_seconds / 60) : '?';
      return {
        html: `
          <div class="tooltip-container matrix-tooltip">
            <div class="tooltip-title">🚗 Route to ${r?.name || 'Restaurant'}</div>
            <div class="tooltip-divider"></div>
            <div class="tooltip-row"><span class="tooltip-label">Distance</span><span class="tooltip-value">${dist} km</span></div>
            <div class="tooltip-row"><span class="tooltip-label">Drive Time</span><span class="tooltip-value highlight">${dur} min</span></div>
            <div class="tooltip-row"><span class="tooltip-label">Progress</span><span class="tooltip-value">${Math.round(animProgress * 100)}%</span></div>
          </div>
        `,
        style: { background: 'transparent', border: 'none', padding: '0' },
      };
    }
    if (layer?.id === 'flood-zones' && object?.properties) {
      const p = object.properties;
      return {
        html: `
          <div class="tooltip-container" style="border-left: 3px solid #ff4444;">
            <div class="tooltip-title" style="color:#ff6b6b;">&#9888; ${p.title || 'Flood Zone'}</div>
            <div class="tooltip-divider"></div>
            <div class="tooltip-row"><span class="tooltip-label">Severity</span><span class="tooltip-value" style="color:#ff6b6b">${(p.severity || '').toUpperCase()}</span></div>
            ${p.water_level ? `<div class="tooltip-row"><span class="tooltip-label">Water Level</span><span class="tooltip-value">${p.water_level}m</span></div>` : ''}
            ${p.roads ? `<div class="tooltip-row"><span class="tooltip-label">Roads Affected</span><span class="tooltip-value">~${p.roads}</span></div>` : ''}
            ${p.description ? `<div class="tooltip-row"><span class="tooltip-label" style="color:#aaa;font-style:italic">${p.description.slice(0, 100)}...</span></div>` : ''}
          </div>
        `,
        style: { background: 'transparent', border: 'none', padding: '0' },
      };
    }
    return null;
  }, [reachData.length, hoveredRestaurant, animatedRoute, animProgress]);

  const clearSelection = useCallback(() => {
    setSelectedOrigin(null);
    setReachData([]);
    setAnimatedRoute(null);
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

      {(mapFilter.type !== 'all' || statusFilter !== 'all') && (
        <div className="map-filter-badge">
          Showing: {mapFilter.type !== 'all' ? mapFilter.label : (statusFilter === 'active' ? 'Active Only' : statusFilter.replace('_', ' '))}
          <span className="map-filter-count">{routesWithCoords.length} routes</span>
          {mapFilter.type !== 'all' && onClearMapFilter && (
            <button className="map-filter-clear" onClick={onClearMapFilter}>✕</button>
          )}
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
            { key: 'couriers', label: 'Couriers', color: '#FFD54F' },
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

      {mapMode === 'routes' && availableDates.length > 1 && (
        <div className="date-slider-panel">
          <div className="date-slider-header">
            <span className="date-slider-label">Day</span>
            <span className="date-slider-value">
              {selectedDateIdx === -1 ? 'All Days' : formatDateLabel(availableDates[selectedDateIdx].date, true)}
              {selectedDateIdx >= 0 && ` (${availableDates[selectedDateIdx].count} orders)`}
            </span>
          </div>
          <input
            type="range"
            min={-1}
            max={availableDates.length - 1}
            value={selectedDateIdx}
            onChange={(e) => setSelectedDateIdx(Number(e.target.value))}
            className="date-slider-input"
          />
          <div className="date-slider-ticks">
            <span>All</span>
            {availableDates.map((d) => (
              <span key={d.date}>{formatDateLabel(d.date)}</span>
            ))}
          </div>
        </div>
      )}

      {mapMode === 'routes' && selectedDate && (
        <div className="date-slider-panel" style={{ top: availableDates.length > 1 ? '100px' : '12px' }}>
          <div className="date-slider-header">
            <span className="date-slider-label">Hour</span>
            <span className="date-slider-value">
              {selectedHour === -1 ? 'All Hours' : `${String(selectedHour).padStart(2, '0')}:00`}
              {selectedHour >= 0 && courierPositions.length > 0 && ` (${courierPositions.length} couriers)`}
              {couriersLoading && ' ...'}
            </span>
          </div>
          <input
            type="range"
            min={-1}
            max={23}
            value={selectedHour}
            onChange={(e) => setSelectedHour(Number(e.target.value))}
            className="date-slider-input"
          />
          <div className="date-slider-ticks">
            <span>All</span>
            <span>06:00</span>
            <span>12:00</span>
            <span>18:00</span>
            <span>23:00</span>
          </div>
        </div>
      )}

      {mapMode === 'matrix' && (
        <div className="matrix-resolution-selector">
          <span className="matrix-res-label">Resolution</span>
          {([7, 8, 9, 10] as MatrixResolution[]).map((r) => (
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

      {routeLoading && (
        <div className="map-loading" style={{ top: 'auto', bottom: 80 }}>
          🚗 {routeLoadingMsg || 'Fetching route...'}
        </div>
      )}

      {animatedRoute && !routeLoading && (
        <div className="animated-route-info">
          <div className="animated-route-header">
            <span>🚗 Route to {animatedRoute.restaurant?.name || 'Restaurant'}</span>
            <button className="matrix-origin-clear" onClick={() => setAnimatedRoute(null)}>&times;</button>
          </div>
          <div className="animated-route-stats">
            <span>{(animatedRoute.distance_meters / 1000).toFixed(1)} km</span>
            <span>&middot;</span>
            <span>{Math.round(animatedRoute.duration_seconds / 60)} min drive</span>
          </div>
        </div>
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
            <div className="color-legend-item">
              <div className="color-legend-swatch" style={{ background: '#FFD54F', borderRadius: '50%', border: '2px solid white' }} />
              Courier (in transit)
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

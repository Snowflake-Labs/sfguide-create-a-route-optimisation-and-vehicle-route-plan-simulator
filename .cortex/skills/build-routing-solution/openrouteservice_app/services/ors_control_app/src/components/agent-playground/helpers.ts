// Agent playground constants, types, and pure helpers.
// Map basemap, polyline decoder, POI category color/name maps, geo extraction
// from agent tool-results, sample prompt list, and a tool-call JSON stripper.

import { TileLayer } from '@deck.gl/geo-layers';
import { BitmapLayer } from '@deck.gl/layers';

export const CURSOR_BLINK_CSS = `
@keyframes agent-cursor-blink {
  0%, 100% { opacity: 1; }
  50% { opacity: 0; }
}
.agent-cursor {
  display: inline-block;
  width: 2px;
  height: 1em;
  background: currentColor;
  margin-left: 1px;
  vertical-align: text-bottom;
  animation: agent-cursor-blink 0.8s step-end infinite;
}
`;

export function injectCursorBlinkCss(): void {
  if (typeof document === 'undefined') return;
  const existing = document.getElementById('agent-cursor-style');
  if (existing) return;
  const style = document.createElement('style');
  style.id = 'agent-cursor-style';
  style.textContent = CURSOR_BLINK_CSS;
  document.head.appendChild(style);
}

export function cartoBasemap() {
  return new TileLayer({ id: 'carto-basemap', data: '/api/tiles/{z}/{x}/{y}', minZoom: 0, maxZoom: 19, tileSize: 256, renderSubLayers: (props: any) => { const { boundingBox } = props.tile; return new BitmapLayer(props, { data: undefined, image: props.data, bounds: [boundingBox[0][0], boundingBox[0][1], boundingBox[1][0], boundingBox[1][1]] }); } });
}

export function decodePolyline(encoded: string): [number, number][] {
  if (typeof encoded !== 'string') return [];
  const coords: [number, number][] = [];
  let index = 0, lat = 0, lng = 0;
  try {
    while (index < encoded.length) {
      let b, shift = 0, result = 0;
      do { b = encoded.charCodeAt(index++) - 63; result |= (b & 0x1f) << shift; shift += 5; } while (b >= 0x20);
      lat += (result & 1) ? ~(result >> 1) : (result >> 1);
      shift = 0; result = 0;
      do { b = encoded.charCodeAt(index++) - 63; result |= (b & 0x1f) << shift; shift += 5; } while (b >= 0x20);
      lng += (result & 1) ? ~(result >> 1) : (result >> 1);
      coords.push([lng / 1e5, lat / 1e5]);
    }
  } catch {}
  return coords;
}

export interface MarkerPoint { position: [number, number]; color: [number, number, number, number]; label: string; }
export interface PoiPoint { position: [number, number]; name: string; category: string; color: [number, number, number, number]; }
export interface GeoData { geojson: any | null; points: MarkerPoint[]; poiPoints: PoiPoint[]; center: [number, number] | null; zoom: number; }

export interface ChatMsg { role: 'user' | 'assistant'; content: string; toolResults?: any[]; streaming?: boolean; }

const POI_CATEGORY_COLORS: Record<string, [number, number, number, number]> = {
  restaurant: [255, 99, 71, 230],
  fast_food_restaurant: [255, 99, 71, 230],
  casual_eatery: [255, 99, 71, 230],
  fine_dining_restaurant: [255, 99, 71, 230],
  pizzaria: [255, 99, 71, 230],
  chicken_restaurant: [255, 99, 71, 230],
  sandwich_shop: [255, 99, 71, 230],
  sushi_restaurant: [255, 99, 71, 230],
  seafood_restaurant: [255, 99, 71, 230],
  steak_house: [255, 99, 71, 230],
  burger_restaurant: [255, 99, 71, 230],
  cafe: [138, 43, 226, 230],
  coffee_shop: [138, 43, 226, 230],
  bakery: [138, 43, 226, 230],
  tea_house: [138, 43, 226, 230],
  bar: [255, 165, 0, 230],
  pub: [255, 165, 0, 230],
  nightclub: [255, 165, 0, 230],
  lounge: [255, 165, 0, 230],
  hotel: [0, 191, 255, 230],
  motel: [0, 191, 255, 230],
  hostel: [0, 191, 255, 230],
  bed_and_breakfast: [0, 191, 255, 230],
  shop: [50, 205, 50, 230],
  shopping_mall: [50, 205, 50, 230],
  supermarket: [50, 205, 50, 230],
  hospital: [255, 20, 147, 230],
  medical_clinic: [255, 20, 147, 230],
  pharmacy: [255, 20, 147, 230],
  park: [34, 139, 34, 230],
  playground: [34, 139, 34, 230],
  gas_station: [255, 215, 0, 230],
  parking: [169, 169, 169, 230],
};

export function poiColor(category: string): [number, number, number, number] {
  return POI_CATEGORY_COLORS[category] || [100, 149, 237, 230];
}

export const POI_DISPLAY_NAMES: Record<string, string> = {
  restaurant: 'Restaurants', fast_food_restaurant: 'Restaurants', casual_eatery: 'Restaurants',
  fine_dining_restaurant: 'Restaurants', pizzaria: 'Restaurants', chicken_restaurant: 'Restaurants',
  sandwich_shop: 'Restaurants', sushi_restaurant: 'Restaurants', seafood_restaurant: 'Restaurants',
  steak_house: 'Restaurants', burger_restaurant: 'Restaurants',
  cafe: 'Cafes', coffee_shop: 'Cafes', bakery: 'Cafes', tea_house: 'Cafes',
  bar: 'Bars', pub: 'Bars', nightclub: 'Bars', lounge: 'Bars',
  hotel: 'Hotels', motel: 'Hotels', hostel: 'Hotels', bed_and_breakfast: 'Hotels',
  shop: 'Shops', shopping_mall: 'Shops', supermarket: 'Shops',
  hospital: 'Healthcare', medical_clinic: 'Healthcare', pharmacy: 'Healthcare',
  park: 'Parks', playground: 'Parks',
  gas_station: 'Gas Stations',
  parking: 'Parking',
};

// Vehicle / skill / risk palettes used by extractAgentGeoData when rendering
// optimization (TOOL_*_OPTIMIZATION, TOOL_NETWORK_OPTIMIZATION) and catchment
// (TOOL_CATCHMENT) tool results.
export const VEHICLE_ROUTE_COLORS: [number, number, number, number][] = [
  [66, 133, 244, 220],
  [255, 152, 0, 220],
  [76, 175, 80, 220],
  [156, 39, 176, 220],
  [233, 30, 99, 220],
];

export const SKILL_COLORS: Record<number, [number, number, number, number]> = {
  1: [66, 133, 244, 240],
  2: [255, 152, 0, 240],
  3: [76, 175, 80, 240],
};

export const SKILL_LABELS: Record<number, string> = {
  1: 'Cold Chain',
  2: 'Restricted / Controlled',
  3: 'Standard',
};

export function skillColor(skill: number): [number, number, number, number] {
  return SKILL_COLORS[skill] || [100, 149, 237, 240];
}

export function extractAgentGeoData(toolResults: any[]): GeoData {
  const features: any[] = [];
  const markerPoints: MarkerPoint[] = [];
  const poiPoints: PoiPoint[] = [];

  for (const tr of toolResults) {
    if (!tr || typeof tr !== 'object' || tr.status === 'FAILED') continue;
    try {
      // TOOL_DIRECTIONS / TOOL_ISOCHRONE: tr.geometry is a raw GeoJSON geometry object
      if (tr.geometry && typeof tr.geometry === 'object' && tr.geometry.type) {
        const geomType = tr.geometry.type;
        if (geomType === 'LineString' || geomType === 'MultiLineString') {
          features.push({ type: 'Feature', geometry: tr.geometry, properties: { distance: tr.distance_km, duration: tr.duration_mins } });
        } else if (geomType === 'Polygon' || geomType === 'MultiPolygon') {
          features.push({ type: 'Feature', geometry: tr.geometry, properties: { area: tr.area_km2, range: tr.range_minutes } });
        } else if (geomType === 'Feature') {
          features.push(tr.geometry);
        } else if (geomType === 'FeatureCollection') {
          features.push(...(tr.geometry.features || []));
        }
      }
      // TOOL_OPTIMIZATION / TOOL_NETWORK_OPTIMIZATION / TOOL_DELIVERY_OPTIMIZATION:
      // routes array with per-vehicle geometry. Tag each Feature with vehicle
      // id + colour so the map can render distinct lines and the legend can
      // identify them.
      if (tr.routes && Array.isArray(tr.routes)) {
        for (const route of tr.routes) {
          const vehicleIdx = ((route.vehicle ?? 1) - 1);
          const routeColor = VEHICLE_ROUTE_COLORS[vehicleIdx % VEHICLE_ROUTE_COLORS.length];
          let coords: [number, number][] | null = null;
          if (route.geometry && typeof route.geometry === 'string') {
            const decoded = decodePolyline(route.geometry);
            if (decoded.length > 0) coords = decoded;
          } else if (route.geometry && Array.isArray(route.geometry)) {
            coords = route.geometry as [number, number][];
          }
          if (coords) {
            features.push({
              type: 'Feature',
              geometry: { type: 'LineString', coordinates: coords },
              properties: { vehicle: route.vehicle ?? 1, routeColor },
            });
          }
        }
      }
      // TOOL_NETWORK_OPTIMIZATION / TOOL_DELIVERY_OPTIMIZATION: pre-geocoded job stops
      // colored by VROOM skill (1=Cold Chain, 2=Restricted, 3=Standard).
      if (tr.jobs && Array.isArray(tr.jobs)) {
        for (const job of tr.jobs) {
          if (job.longitude != null && job.latitude != null) {
            const skill: number = job.skill ?? (Array.isArray(job.skills) ? job.skills[0] : 0) ?? 0;
            poiPoints.push({
              position: [Number(job.longitude), Number(job.latitude)],
              name: job.name || job.address || job.site || 'Stop',
              category: SKILL_LABELS[skill] || job.skill_label || 'Delivery Stop',
              color: skill ? skillColor(skill) : [100, 149, 237, 240],
            });
          }
        }
      }
      // TOOL_CATCHMENT: per-area demographics with risk score.
      if (Array.isArray(tr.population_points)) {
        for (const pt of tr.population_points) {
          if (pt.longitude == null || pt.latitude == null) continue;
          const risk: number = pt.risk_score ?? 0;
          const color: [number, number, number, number] =
            risk >= 55 ? [231, 76, 60, 220]
            : risk >= 35 ? [230, 126, 34, 200]
            : [46, 204, 113, 180];
          const noCar = Math.round(100 - (pt.car_ownership_pct ?? 50));
          poiPoints.push({
            position: [Number(pt.longitude), Number(pt.latitude)],
            name: `${pt.neighborhood} (pop. ${pt.population?.toLocaleString?.() ?? pt.population})\n` +
                  `Diabetes ${pt.diabetes_pct}%  Hypertension ${pt.hypertension_pct}%\n` +
                  `Elderly ${pt.pct_elderly}%  No car ${noCar}%\n` +
                  `Risk score ${risk}/100`,
            category: risk >= 55 ? 'High Health Risk' : risk >= 35 ? 'Medium Health Risk' : 'Lower Health Risk',
            color,
          });
        }
      }
      // Isochrone center point
      if (tr.center && tr.center.longitude != null && tr.center.latitude != null) {
        markerPoints.push({ position: [tr.center.longitude, tr.center.latitude], color: [245, 158, 11, 255], label: tr.center.name || 'Center' });
      }
      // Optimization depot point
      if (tr.depot && tr.depot.longitude != null && tr.depot.latitude != null) {
        markerPoints.push({ position: [tr.depot.longitude, tr.depot.latitude], color: [245, 158, 11, 255], label: tr.depot.name || 'Depot' });
      }
    } catch {}
  }

  for (const tr of toolResults) {
    if (!tr || typeof tr !== 'object') continue;
    // Two POI list shapes are accepted:
    //   tr.poi_list  — legacy local executeToolPoi shape: { name, lng, lat, category }
    //   tr.pois      — TOOL_POI_IN_ISOCHRONE proc shape:   { name, longitude, latitude, basic_category, primary_category }
    const list: any[] = Array.isArray(tr.poi_list) ? tr.poi_list : (Array.isArray(tr.pois) ? tr.pois : []);
    for (const poi of list) {
      const lng = poi.lng ?? poi.longitude;
      const lat = poi.lat ?? poi.latitude;
      if (lng != null && lat != null) {
        const cat = poi.category || poi.basic_category || poi.primary_category || '';
        poiPoints.push({
          position: [Number(lng), Number(lat)],
          name: poi.name || 'Unknown',
          category: cat,
          color: poiColor(cat),
        });
      }
    }
  }

  if (features.length === 0 && markerPoints.length === 0 && poiPoints.length === 0) return { geojson: null, points: markerPoints, poiPoints, center: null, zoom: 12 };

  const allCoords: [number, number][] = [...markerPoints.map(p => p.position), ...poiPoints.map(p => p.position)];
  for (const f of features) {
    const geom = f.geometry;
    if (!geom) continue;
    if (geom.type === 'Point') allCoords.push(geom.coordinates);
    else if (geom.type === 'LineString') allCoords.push(...geom.coordinates);
    else if (geom.type === 'MultiLineString') geom.coordinates.forEach((l: any) => allCoords.push(...l));
    else if (geom.type === 'Polygon') allCoords.push(...geom.coordinates[0]);
    else if (geom.type === 'MultiPolygon') geom.coordinates.forEach((p: any) => allCoords.push(...p[0]));
  }

  let center: [number, number] | null = null;
  let zoom = 12;
  if (allCoords.length > 0) {
    let minLon = Infinity, maxLon = -Infinity, minLat = Infinity, maxLat = -Infinity;
    for (const [lon, lat] of allCoords) {
      if (lon < minLon) minLon = lon; if (lon > maxLon) maxLon = lon;
      if (lat < minLat) minLat = lat; if (lat > maxLat) maxLat = lat;
    }
    center = [(minLon + maxLon) / 2, (minLat + maxLat) / 2];
    const span = Math.max(maxLon - minLon, maxLat - minLat);
    if (span > 1) zoom = 8; else if (span > 0.5) zoom = 9; else if (span > 0.1) zoom = 11; else if (span > 0.02) zoom = 13; else zoom = 14;
  }

  return { geojson: features.length > 0 ? { type: 'FeatureCollection', features } : null, points: markerPoints, poiPoints, center, zoom };
}

export function stripToolCallJson(text: string): string {
  return text.replace(/```[\s\S]*?```/g, '').replace(/\{[\s\S]*?"tool_call"[\s\S]*?\}/g, '').trim();
}

export const SAMPLE_PROMPTS: { label: string; icon: string; prompt: string }[] = [
  {
    label: 'Restaurants nearby',
    icon: '🍽️',
    prompt: 'Show me restaurants within a 10 minute drive from Union Square, San Francisco',
  },
  {
    label: 'Cycling directions',
    icon: '🚲',
    prompt: 'Get cycling directions from the Ferry Building to Golden Gate Park, San Francisco',
  },
  {
    label: 'Cafes by bike',
    icon: '☕',
    prompt: 'What cafes can I reach within a 15 minute cycle from Civic Center, San Francisco',
  },
  {
    label: 'Hotels near airport',
    icon: '🏨',
    prompt: 'Show me hotels within a 20 minute drive from San Francisco International Airport',
  },
  {
    label: 'Pharmacy delivery routes',
    icon: '🚚',
    prompt: 'I have 3 vehicles starting from a warehouse at 1 Market Street, San Francisco. Optimise routes to deliver to these pharmacies: Walgreens at 498 Castro Street, CVS at 2676 Geary Blvd, Walgreens at 3201 Divisadero Street, CVS at 3700 Sacramento Street, Rite Aid at 801 Clement Street, and Walgreens at 2690 Mission Street.',
  },
  {
    label: 'Multi-stop drive',
    icon: '📍',
    prompt: 'Get driving directions from Fisherman\'s Wharf to Alcatraz Ferry, then to Pier 39, then to the Embarcadero, San Francisco',
  },
];

export const EMPTY_GEO: GeoData = { geojson: null, points: [], poiPoints: [], center: null, zoom: 12 };

// Map a fleet "vehicle type" (truck / ebike / car / ...) to the matching ORS
// transport profile. Default is driving-car for unknown types.
export function profileFromVehicle(vehicleType: string | null | undefined): string {
  const v = (vehicleType || '').toLowerCase();
  if (!v) return 'driving-car';
  if (v.includes('hgv') || v.includes('truck') || v.includes('lorry') || v.includes('semi')) return 'driving-hgv';
  if (v.includes('ebike') || v.includes('e-bike') || v.includes('electric_bike') || v.includes('cycling-electric')) return 'cycling-electric';
  if (v.includes('mountain')) return 'cycling-mountain';
  if (v.includes('road_bike') || v.includes('cycling-road')) return 'cycling-road';
  if (v.includes('bike') || v.includes('bicycle') || v.includes('cycle')) return 'cycling-regular';
  if (v.includes('walk') || v.includes('foot') || v.includes('pedestrian')) return 'foot-walking';
  if (v.includes('hike')) return 'foot-hiking';
  if (v.includes('wheelchair')) return 'wheelchair';
  return 'driving-car';
}

// ---------------------------------------------------------------------------
// Scenario / saved-prompts / workflow types (added when porting the SUMMIT
// Agent Playground UX into the current refactored AgentPlayground).
// ---------------------------------------------------------------------------

export interface ScenarioPrompt { label: string; icon: string; prompt: string; }
export interface DemoScenario {
  id: string;
  label: string;
  icon: string;
  description: string;
  prompts: ScenarioPrompt[];
}
export interface AgentDemosConfig {
  version?: string;
  default_scenario?: string;
  max_token_limit?: number;
  scenarios: DemoScenario[];
}

export interface SavedPrompt { id: string; label: string; prompt: string; icon?: string; }
export const SAVED_PROMPTS_KEY = 'agent_playground_saved_prompts';

export function loadSavedPrompts(): SavedPrompt[] {
  try {
    const raw = localStorage.getItem(SAVED_PROMPTS_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch { return []; }
}

export function persistSavedPrompts(prompts: SavedPrompt[]) {
  try { localStorage.setItem(SAVED_PROMPTS_KEY, JSON.stringify(prompts)); } catch {}
}

export interface WorkflowStep {
  type: string;
  label: string;
  ts: number;
  duration_ms?: number;
  tool?: string;
  input?: any;
  detail?: any;
}

export const FALLBACK_SCENARIOS: DemoScenario[] = [
  {
    id: 'catchment',
    label: 'Catchment & Delivery',
    icon: '\u{1F4CD}',
    description: 'Catchment analysis and delivery planning',
    prompts: [
      { label: '1. Catchment analysis', icon: '\u{1F4CD}', prompt: 'Show me the area profile within a 10 minute drive of 498 Castro Street, San Francisco' },
      { label: '2. Demand signals', icon: '\u{1F4CA}', prompt: 'Based on that catchment population, which demand segments are highest? Consider the area demographics.' },
      { label: '3. Network plan', icon: '\u{1F69A}', prompt: 'Plan the full distribution-network delivery from the depot to all key sites using 3 vehicles' },
    ],
  },
];

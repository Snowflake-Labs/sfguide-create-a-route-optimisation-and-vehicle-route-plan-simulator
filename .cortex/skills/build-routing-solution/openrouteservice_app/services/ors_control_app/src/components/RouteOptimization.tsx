import { useState, useEffect, useMemo, useCallback } from 'react';
import MetricCard from '../shared/MetricCard';
import DeckGL from '@deck.gl/react';
import { ScatterplotLayer, GeoJsonLayer } from '@deck.gl/layers';
import { BitmapLayer } from '@deck.gl/layers';
import { TileLayer } from '@deck.gl/geo-layers';
import { useRegion } from '../hooks/useRegion';
import { useActivePreset } from '../hooks/useActivePreset';
import { useFitMap } from '../shared/useFitMap';
import RecenterButton from '../shared/RecenterButton';
import { coordsFromGeoJSON, type LngLat } from '../shared/mapFit';

const RO_DB = 'FLEET_INTELLIGENCE';
const RO_SCHEMA = 'ROUTE_OPTIMIZATION';
const CARTO_LIGHT = '/api/tiles/{z}/{x}/{y}';

import { sfQuery as sharedSfQuery, asSqlJsonLiteral, type SfQueryOpts } from '../lib/sfQuery';
async function sfQuery(sql: string, database = RO_DB, schema = RO_SCHEMA, opts?: SfQueryOpts): Promise<any[]> {
  return sharedSfQuery(sql, database, schema, opts);
}

function cartoBasemap() {
  return new TileLayer({ id: 'carto-basemap', data: CARTO_LIGHT, minZoom: 0, maxZoom: 19, tileSize: 256, renderSubLayers: (props: any) => { const { boundingBox } = props.tile; return new BitmapLayer(props, { data: undefined, image: props.data, bounds: [boundingBox[0][0], boundingBox[0][1], boundingBox[1][0], boundingBox[1][1]] }); } });
}

const ROUTE_COLORS: [number, number, number][] = [[41, 181, 232], [34, 197, 94], [245, 158, 11], [239, 68, 68], [128, 0, 255], [255, 105, 180], [0, 191, 255], [50, 205, 50]];

const PROFILE_LABELS: Record<string, string> = {
  'driving-car': 'Car',
  'driving-hgv': 'HGV',
  'cycling-regular': 'Bicycle',
  'cycling-electric': 'E-Bike',
  'cycling-mountain': 'Mountain Bike',
  'cycling-road': 'Road Bike',
  'foot-walking': 'Walking',
  'foot-hiking': 'Hiking',
  'wheelchair': 'Wheelchair',
};

const DEFAULT_skillLabels: Record<number, string> = { 1: 'Refrigerated Vehicle', 2: 'Temperature Controlled', 3: 'Heavy Lift / Pallet Jack', 4: 'Solo Taxi (Behavioural)', 5: 'Wheelchair Accessible', 6: 'Chaperoned', 7: 'Standard Minibus' };
const SKILL_CAPACITY: Record<number, number> = { 1: 10, 2: 10, 3: 10, 4: 1, 5: 2, 6: 3, 7: 8 };
const SKILL_SERVICE_MINS: Record<number, number> = { 1: 5, 2: 5, 3: 5, 4: 10, 5: 10, 6: 8, 7: 3 };

interface VehicleConfig { id: number; profile: string; skills: number[]; startLng: number; startLat: number; endLng: number; endLat: number; capacity: number; }
interface JobAssignment { jobIdx: number; vehicleIdx: number; placeName: string; category: string; lng: number; lat: number; arrival?: number; address?: string; timeWindow?: string; skills?: string; sequence?: number; totalStops?: number; }
interface RouteDirections { vehicleIdx: number; profile: string; totalDistance: number; totalDuration: number; steps: { instruction: string; distance: number; duration: number; name: string; }[]; }
interface JobTemplateLocal { id: number; slotStart: string; slotEnd: string; skills: number[]; product: string; industry: string; serviceDuration: number; }

function secsToHHMM(s: any): string {
  if (typeof s === 'string' && s.includes(':')) return s;
  const n = Number(s);
  if (isNaN(n) || n === 0) return '08:00';
  return `${String(Math.floor(n / 3600)).padStart(2, '0')}:${String(Math.floor((n % 3600) / 60)).padStart(2, '0')}`;
}

function hhmmToSecs(s: any): number {
  if (typeof s !== 'string' || !s.includes(':')) {
    const n = Number(s);
    return Number.isFinite(n) ? n : 0;
  }
  const [h, m] = s.split(':').map(Number);
  return (h || 0) * 3600 + (m || 0) * 60;
}

export default function RouteOptimization() {
  const preset = useActivePreset();
  const { regionName, displayName, center, zoom } = useRegion();
  const [searchText, setSearchText] = useState('');
  const [centerCoords, setCenterCoords] = useState<[number, number] | null>(null);
  const [radius, setRadius] = useState(5);
  const [industries, setIndustries] = useState<any[]>([]);
  const [selectedIndustry, setSelectedIndustry] = useState('');
  const [skillLabels, setSkillLabels] = useState<Record<number, string>>(DEFAULT_skillLabels);
  const [places, setPlaces] = useState<any[]>([]);
  const [jobs, setJobs] = useState<any[]>([]);
  const [jobTemplates, setJobTemplates] = useState<JobTemplateLocal[]>([]);
  const [vehicles, setVehicles] = useState<VehicleConfig[]>([{ id: 1, profile: preset.orsProfile, skills: [1], startLng: center.lng, startLat: center.lat, endLng: center.lng, endLat: center.lat, capacity: 10 }]);
  const [availableProfiles, setAvailableProfiles] = useState<string[]>([]);
  const [isoMinutes, setIsoMinutes] = useState(15);
  const [catchmentGeoJson, setCatchmentGeoJson] = useState<any>(null);
  const [vrpResult, setVrpResult] = useState<any>(null);
  const [routePaths, setRoutePaths] = useState<any[]>([]);
  const [solving, setSolving] = useState(false);
  const [geocoding, setGeocoding] = useState(false);
  const [showVehicleBuilder, setShowVehicleBuilder] = useState(false);
  const [showJobTemplates, setShowJobTemplates] = useState(false);
  const [maxJobs, setMaxJobs] = useState(50);
  const [loading, setLoading] = useState(false);
  const [nearbySchools, setNearbySchools] = useState<any[]>([]);
  const [selectedSchools, setSelectedSchools] = useState<any[]>([]);
  const [depotLabel, setDepotLabel] = useState('Depot');
  const [skillCapacity, setSkillCapacity] = useState<Record<number, number>>({ 1: 10, 2: 10, 3: 10 });
  const [activeResultTab, setActiveResultTab] = useState<'map' | 'assignments'>('map');
  const [jobAssignments, setJobAssignments] = useState<JobAssignment[]>([]);
  const [routeDirections, setRouteDirections] = useState<RouteDirections[]>([]);
  const [loadingDirections, setLoadingDirections] = useState(false);
  const [expandedRoute, setExpandedRoute] = useState<number | null>(null);
  const [showPOIs, setShowPOIs] = useState(true);
  const [showRoutes, setShowRoutes] = useState(true);
  const [showCatchment, setShowCatchment] = useState(true);
  const [showDepot, setShowDepot] = useState(true);
  const [unassignedJobIds, setUnassignedJobIds] = useState<Set<number>>(new Set());
  const [unassignedExplanation, setUnassignedExplanation] = useState('');
  const [fleetRecommendation, setFleetRecommendation] = useState<VehicleConfig[] | null>(null);
  const [loadingPresetData, setLoadingPresetData] = useState(false);

  const depotCoords = useMemo<[number, number] | null>(
    () => (selectedSchools[0] ? [Number(selectedSchools[0].LNG), Number(selectedSchools[0].LAT)] : null),
    [selectedSchools]
  );
  const vehicleHomeCoords = useMemo<[number, number]>(
    () => depotCoords || centerCoords || [center.lng, center.lat],
    [depotCoords, centerCoords, center.lng, center.lat]
  );

  useEffect(() => {
    const lng = Number(center.lng);
    const lat = Number(center.lat);
    if (Number.isFinite(lng) && Number.isFinite(lat) && (lng !== 0 || lat !== 0)) {
      setVehicles(prev => prev.map(v => ({ ...v, startLng: lng, startLat: lat, endLng: lng, endLat: lat })));
    }
    setSearchText(displayName);
    setCenterCoords(null);
    setPlaces([]);
    setJobs([]);
    setRoutePaths([]);
    setVrpResult(null);
    setCatchmentGeoJson(null);
    setJobAssignments([]);
    setRouteDirections([]);
    setUnassignedJobIds(new Set());
    setUnassignedExplanation('');
    setFleetRecommendation(null);
    setNearbySchools([]);
    setSelectedSchools([]);
  }, [center.lng, center.lat, zoom, displayName]);

  useEffect(() => {
    if (!regionName) return;
    let cancelled = false;
    setLoadingPresetData(true);
    setIndustries([]);
    (async () => {
      const r = await sfQuery(`SELECT DISTINCT INDUSTRY FROM LOOKUP WHERE REGION = '${regionName}' ORDER BY INDUSTRY`);
      if (!cancelled) {
        setIndustries(r);
        setLoadingPresetData(false);
      }
    })();
    return () => { cancelled = true; };
  }, [regionName]);

  // Load profiles available on the active region's ORS service.
  useEffect(() => {
    if (!regionName) { setAvailableProfiles([]); return; }
    let cancelled = false;
    (async () => {
      try {
        const rows = await sfQuery(
          `SELECT TO_VARCHAR(OPENROUTESERVICE_APP.CORE.ORS_STATUS('${regionName.replace(/'/g, "''")}')) AS S`,
          'OPENROUTESERVICE_APP', 'CORE'
        );
        if (cancelled) return;
        const raw = rows?.[0]?.S;
        if (!raw) { setAvailableProfiles([]); return; }
        const data = typeof raw === 'string' ? JSON.parse(raw) : raw;
        const profiles: string[] = Object.keys(data?.profiles || {});
        setAvailableProfiles(profiles);
        if (profiles.length) {
          setVehicles(prev => prev.map(v =>
            profiles.includes(v.profile) ? v : { ...v, profile: profiles[0] }
          ));
        }
      } catch (e) {
        if (!cancelled) setAvailableProfiles([]);
        console.warn('[RouteOpt] ORS_STATUS failed for', regionName, e);
      }
    })();
    return () => { cancelled = true; };
  }, [regionName]);

  useEffect(() => {
    if (!selectedIndustry) { setSkillLabels(DEFAULT_skillLabels); return; }
    sfQuery(`SELECT STYPE FROM LOOKUP WHERE REGION = '${regionName}' AND INDUSTRY = '${selectedIndustry}' LIMIT 1`).then(r => {
      if (r.length > 0 && r[0].STYPE) {
        try {
          const stypes = typeof r[0].STYPE === 'string' ? JSON.parse(r[0].STYPE) : r[0].STYPE;
          if (Array.isArray(stypes) && stypes.length > 0) {
            const labels: Record<number, string> = {};
            stypes.forEach((s: string, i: number) => { labels[i + 1] = s; });
            setSkillLabels(labels);
            return;
          }
        } catch {}
      }
      setSkillLabels(DEFAULT_skillLabels);
    });
  }, [selectedIndustry, regionName]);

  const geocode = useCallback(async () => {
    if (!searchText.trim()) return;
    setGeocoding(true);
    const rows = await sfQuery(`SELECT SNOWFLAKE.CORTEX.COMPLETE('claude-sonnet-4-5', 'Give me the latitude and longitude for "${searchText.replace(/'/g, "''")}". Reply ONLY with JSON: {"lat":number,"lng":number}') AS RESULT`);
    try {
      const raw = (rows[0]?.RESULT || '{}').replace(/```json\s*/gi, '').replace(/```/g, '').trim();
      const parsed = JSON.parse(raw);
      if (parsed.lat && parsed.lng) {
        setCenterCoords([parsed.lng, parsed.lat]);
        setVehicles(prev => prev.map(v => ({ ...v, startLng: parsed.lng, startLat: parsed.lat, endLng: parsed.lng, endLat: parsed.lat })));
      }
    } catch {}
    setGeocoding(false);
  }, [searchText]);

  const loadPlaces = useCallback(async () => {
    if (!centerCoords || !selectedIndustry) return;
    setLoading(true);
    // LOOKUP may not have SOURCE_TABLE/DEPOT_CTYPE/DEPOT_LABEL columns on older
    // installs. Probe schema first and fall back gracefully.
    let lookupRows: any[] = [];
    try {
      lookupRows = await sfQuery(`SELECT SOURCE_TABLE, DEPOT_CTYPE, DEPOT_LABEL FROM LOOKUP WHERE REGION = '${regionName}' AND INDUSTRY = '${selectedIndustry}' LIMIT 1`);
    } catch {
      lookupRows = [];
    }
    const sourceTable = lookupRows?.[0]?.SOURCE_TABLE || null;
    const depotCtype = lookupRows?.[0]?.DEPOT_CTYPE;
    const dLabel = lookupRows?.[0]?.DEPOT_LABEL || 'Depot';
    setDepotLabel(dLabel);

    // Skill capacities come from STYPE length (a sensible default per industry).
    setSkillCapacity({ 1: 10, 2: 10, 3: 10 });

    let placesQuery: string;
    if (sourceTable) {
      placesQuery = `SELECT NAME, CATEGORY, LNG, LAT, ADDRESS, DISPLAY_ADDRESS
           FROM ${sourceTable}
           WHERE REGION = '${regionName}'
           ORDER BY RANDOM()
           LIMIT 200`;
    } else {
      placesQuery = `SELECT p.NAME, p.CATEGORY, ST_X(p.GEOMETRY) AS LNG, ST_Y(p.GEOMETRY) AS LAT, p.ADDRESS
           FROM V_PLACES_CURRENT p, LOOKUP l
           WHERE p.REGION = '${regionName}'
             AND l.REGION = '${regionName}'
             AND l.INDUSTRY = '${selectedIndustry}'
             AND ARRAY_CONTAINS(p.CATEGORY::VARIANT, l.CTYPE)
             AND ST_DWITHIN(p.GEOMETRY, ST_MAKEPOINT(${centerCoords[0]}, ${centerCoords[1]}), ${radius * 1000})
           ORDER BY RANDOM()
           LIMIT 200`;
    }
    // JOB_TEMPLATE.INDUSTRY may not exist on older installs - fall back without it.
    let jobRows: any[] = [];
    try {
      jobRows = await sfQuery(`SELECT ID, SLOT_START, SLOT_END, SKILLS, PRODUCT, INDUSTRY, STATUS FROM JOB_TEMPLATE WHERE REGION = '${regionName}' AND STATUS = 'active' AND INDUSTRY = '${selectedIndustry}' LIMIT 30`);
    } catch {
      jobRows = [];
    }
    if (!jobRows.length) {
      jobRows = await sfQuery(`SELECT ID, SLOT_START, SLOT_END, SKILLS, PRODUCT, STATUS FROM JOB_TEMPLATE WHERE REGION = '${regionName}' AND STATUS = 'active' LIMIT 30`);
    }
    const p = await sfQuery(placesQuery);
    setPlaces(p);
    setJobs(jobRows);

    if (depotCtype) {
      try {
        const cats = (typeof depotCtype === 'string' ? JSON.parse(depotCtype) : depotCtype) as string[];
        const catStr = cats.map((c: string) => `'${c}'`).join(',');
        const depots = await sfQuery(`SELECT NAME, ST_X(GEOMETRY) AS LNG, ST_Y(GEOMETRY) AS LAT FROM V_PLACES_CURRENT WHERE REGION = '${regionName}' AND CATEGORY IN (${catStr}) AND ST_DWITHIN(GEOMETRY, ST_MAKEPOINT(${centerCoords[0]}, ${centerCoords[1]}), ${radius * 1000}) ORDER BY NAME LIMIT 10`);
        setNearbySchools(depots);
        if (depots.length > 0 && selectedSchools.length === 0) {
          const first = depots[0];
          setSelectedSchools([first]);
          setVehicles(prev => prev.map(v => ({ ...v, startLng: Number(first.LNG), startLat: Number(first.LAT), endLng: Number(first.LNG), endLat: Number(first.LAT) })));
        }
      } catch {
        setNearbySchools([]);
        setSelectedSchools([]);
      }
    } else {
      setNearbySchools([]);
      setSelectedSchools([]);
    }

    const templates: JobTemplateLocal[] = jobRows.map((jt: any) => {
      let sk: number[] = [];
      try {
        const s = typeof jt.SKILLS === 'string' ? JSON.parse(jt.SKILLS) : jt.SKILLS;
        sk = (Array.isArray(s) ? s : [s]).map(Number).filter((n: number) => !isNaN(n));
      } catch {}
      return { id: jt.ID, slotStart: secsToHHMM(jt.SLOT_START), slotEnd: secsToHHMM(jt.SLOT_END), skills: sk, product: jt.PRODUCT || '', industry: jt.INDUSTRY || '', serviceDuration: SKILL_SERVICE_MINS[sk[0]] || 5 };
    });
    setJobTemplates(templates);
    setLoading(false);
  }, [centerCoords, radius, selectedIndustry, regionName]);

  useEffect(() => { if (centerCoords) loadPlaces(); }, [centerCoords, radius, selectedIndustry]);

  useEffect(() => {
    if (jobTemplates.length === 0 || !centerCoords) { setFleetRecommendation(null); return; }
    const jobCount = Math.min(places.length, maxJobs);
    const skillCounts: Record<number, number> = {};
    for (let i = 0; i < jobCount; i++) {
      const jt = jobTemplates[i % jobTemplates.length];
      jt.skills.forEach(s => { skillCounts[s] = (skillCounts[s] || 0) + 1; });
    }
    const recommended: VehicleConfig[] = [];
    let id = 1;
    const baseProfile = availableProfiles.includes(preset.orsProfile) ? preset.orsProfile : (availableProfiles[0] || preset.orsProfile);
    for (const [skillStr, count] of Object.entries(skillCounts)) {
      const skill = Number(skillStr);
      const cap = skillCapacity[skill] || SKILL_CAPACITY[skill] || 10;
      const numVehicles = Math.max(1, Math.ceil(count / cap));
      for (let i = 0; i < numVehicles; i++) {
        recommended.push({ id: id++, profile: baseProfile, skills: [skill], startLng: vehicleHomeCoords[0], startLat: vehicleHomeCoords[1], endLng: vehicleHomeCoords[0], endLat: vehicleHomeCoords[1], capacity: cap });
      }
    }
    setFleetRecommendation(recommended);
  }, [jobTemplates, centerCoords, maxJobs, places.length, availableProfiles, skillCapacity, vehicleHomeCoords]);

  const previewCatchment = useCallback(async () => {
    if (!centerCoords) return;
    try {
      const rows = await sfQuery(`SELECT GEOJSON AS GEO, RESPONSE::VARCHAR AS RESP FROM TABLE(OPENROUTESERVICE_APP.CORE.ISOCHRONES('${vehicles[0].profile}', ${centerCoords[0]}::FLOAT, ${centerCoords[1]}::FLOAT, ${isoMinutes}::INT, '${regionName}'))`, 'OPENROUTESERVICE_APP', 'CORE');
      if (!rows[0]?.GEO) {
        let msg = 'No isochrone returned';
        try {
          const respObj = rows[0]?.RESP ? JSON.parse(rows[0].RESP) : {};
          msg = respObj.message || respObj.error || msg;
        } catch {}
        alert(`Catchment preview failed for ${regionName}: ${msg}`);
        return;
      }
      try { setCatchmentGeoJson(JSON.parse(rows[0].GEO)); } catch (e) { console.error('[Catchment] JSON parse error:', e); }
    } catch (e: any) {
      console.error('[Catchment] error:', e);
      alert(`Catchment preview error: ${e?.message || e}`);
    }
  }, [centerCoords, vehicles, isoMinutes, regionName]);

  const fetchDirections = useCallback(async (vrpRows: any[], vehicleConfigs: VehicleConfig[]) => {
    setLoadingDirections(true);
    const directions: RouteDirections[] = [];
    for (const row of vrpRows) {
      const vIdx = (row.VEHICLE || 1) - 1;
      const profile = vehicleConfigs[vIdx]?.profile || preset.orsProfile;
      let steps: any[] = [];
      try { steps = typeof row.STEPS === 'string' ? JSON.parse(row.STEPS) : row.STEPS; } catch {}
      if (!Array.isArray(steps) || steps.length < 2) continue;
      const waypoints = steps.filter((s: any) => s.location).map((s: any) => s.location);
      if (waypoints.length < 2) continue;
      const coordsPayload = JSON.stringify({ coordinates: waypoints }).replace(/'/g, "''");
      try {
        const dirRows = await sfQuery(`SELECT RESPONSE, DISTANCE, DURATION FROM TABLE(OPENROUTESERVICE_APP.CORE.DIRECTIONS('${profile}', PARSE_JSON('${coordsPayload}')))`, 'OPENROUTESERVICE_APP', 'CORE');
        if (dirRows.length > 0) {
          const resp = typeof dirRows[0].RESPONSE === 'string' ? JSON.parse(dirRows[0].RESPONSE) : dirRows[0].RESPONSE;
          const segments = resp?.features?.[0]?.properties?.segments || [];
          const allSteps: RouteDirections['steps'] = [];
          for (const seg of segments) {
            for (const st of (seg.steps || [])) {
              allSteps.push({ instruction: st.instruction || '', distance: st.distance || 0, duration: st.duration || 0, name: st.name || '' });
            }
          }
          directions.push({ vehicleIdx: vIdx, profile, totalDistance: dirRows[0].DISTANCE || 0, totalDuration: dirRows[0].DURATION || 0, steps: allSteps });
        }
      } catch (e) {
        console.error('[Directions] Failed for vehicle', vIdx, e);
      }
    }
    setRouteDirections(directions);
    setLoadingDirections(false);
  }, []);

  const optimizeRoutes = useCallback(async () => {
    if (!places.length) return;
    setSolving(true);
    setRoutePaths([]);
    setVrpResult(null);
    setJobAssignments([]);
    setRouteDirections([]);
    setUnassignedJobIds(new Set());
    setUnassignedExplanation('');

    const vrpJobs = places.slice(0, maxJobs).map((p: any, i: number) => {
      const jt = jobTemplates[i % (jobTemplates.length || 1)];
      const slotStartSecs = hhmmToSecs(jt?.slotStart || '06:00');
      const slotEndSecs = hhmmToSecs(jt?.slotEnd || '20:00');
      return {
        id: i + 1,
        location: [Number(p.LNG), Number(p.LAT)],
        service: (jt?.serviceDuration || 5) * 60,
        skills: jt?.skills?.length ? jt.skills : [(i % 3) + 1],
        delivery: [1],
        time_windows: [[slotStartSecs, slotEndSecs]],
      };
    });
    const isSenTransport = selectedIndustry === 'SEN Transport';
    const vrpVehicles = vehicles.map((v, i) => {
      const veh: any = {
        id: i + 1,
        profile: v.profile || preset.orsProfile,
        start: [v.startLng, v.startLat],
        end: [v.endLng, v.endLat],
        capacity: [Number(v.capacity)],
        skills: v.skills.length ? v.skills : [(i % 3) + 1],
        time_window: [21600, 72000],
      };
      if (isSenTransport) veh.max_travel_time = 7200;
      return veh;
    });

    const vrpChallenge = { jobs: vrpJobs, vehicles: vrpVehicles };
    const vrpSql = `SELECT * FROM TABLE(OPENROUTESERVICE_APP.CORE.OPTIMIZATION(PARSE_JSON(${asSqlJsonLiteral(vrpChallenge)}), '${regionName}'))`;
    let rows: any[] = [];
    try {
      rows = await sfQuery(vrpSql, 'OPENROUTESERVICE_APP', 'CORE', { throwOnError: true });
    } catch (e: any) {
      console.error('[VRP] error:', e);
      alert(`Optimize Routes error: ${e?.message || e}`);
      setSolving(false);
      return;
    }
    if (rows.length === 0) {
      let msg = 'No routes returned from solver';
      try {
        const errRows = await sfQuery(`SELECT OPENROUTESERVICE_APP.CORE._OPTIMIZATION_RAW(PARSE_JSON(${asSqlJsonLiteral(vrpChallenge)}), '${regionName}')::VARCHAR AS RESP`, 'OPENROUTESERVICE_APP', 'CORE');
        const respObj = errRows[0]?.RESP ? JSON.parse(errRows[0].RESP) : {};
        if (respObj.error) msg = `${respObj.error}: ${respObj.message || ''}`;
      } catch {}
      alert(`Route optimization failed for ${regionName}: ${msg}\n\nThe VROOM service may be warming up. Try again in 10-30 seconds.`);
      setSolving(false);
      return;
    }
    setVrpResult(rows[0]);
    const paths: any[] = [];
    const assignments: JobAssignment[] = [];
    const assignedIds = new Set<number>();

    for (const row of rows) {
      const vIdx = (row.VEHICLE || 1) - 1;
      if (row.GEOJSON) {
        try {
          const geojson = typeof row.GEOJSON === 'string' ? JSON.parse(row.GEOJSON) : row.GEOJSON;
          paths.push({ vehicleIdx: vIdx, geojson });
        } catch {}
      }
      let steps: any[] = [];
      try { steps = typeof row.STEPS === 'string' ? JSON.parse(row.STEPS) : (row.STEPS || []); } catch {}
      if (Array.isArray(steps)) {
        let seq = 0;
        const jobSteps = steps.filter((s: any) => s.type === 'job');
        for (const step of jobSteps) {
          if (step.id != null) {
            seq++;
            assignedIds.add(step.id);
            const jobIdx = step.id - 1;
            const place = places[jobIdx];
            const jt = jobTemplates[jobIdx % (jobTemplates.length || 1)];
            if (place) {
              let addr = place.DISPLAY_ADDRESS || '';
              if (!addr) {
                try {
                  if (place.ADDRESS) {
                    const a = typeof place.ADDRESS === 'string' ? JSON.parse(place.ADDRESS) : place.ADDRESS;
                    addr = a?.freeform || '';
                    if (a?.locality) addr += `, ${a.locality}`;
                  }
                } catch {}
              }
              const skillsStr = jt?.skills?.length ? jt.skills.map((n: number) => skillLabels[n] || `Skill ${n}`).join(', ') : '';
              const isOverride = place.CATEGORY === 'student_pickup';
              const displayName = isOverride ? (addr || place.NAME || '') : (place.NAME || '');
              assignments.push({ jobIdx, vehicleIdx: vIdx, placeName: displayName, category: isOverride ? 'Student Pickup' : (place.CATEGORY || ''), lng: Number(place.LNG), lat: Number(place.LAT), arrival: step.arrival, address: isOverride ? '' : addr, timeWindow: jt ? `${jt.slotStart} - ${jt.slotEnd}` : '', skills: skillsStr, sequence: seq, totalStops: jobSteps.length });
            }
          }
        }
      }
    }

    const unassigned = new Set<number>();
    for (let i = 1; i <= vrpJobs.length; i++) {
      if (!assignedIds.has(i)) unassigned.add(i);
    }
    setUnassignedJobIds(unassigned);
    setRoutePaths(paths);
    setJobAssignments(assignments);
    fetchDirections(rows, vehicles);

    if (unassigned.size > 0) {
      const unassignedSkills = Array.from(unassigned).map(id => {
        const jt = jobTemplates[(id - 1) % (jobTemplates.length || 1)];
        return jt?.skills?.map((s: number) => skillLabels[s] || `Skill ${s}`).join(', ') || 'unknown';
      });
      const vehicleSkills = vehicles.map((v, i) => `Vehicle ${i + 1}: ${v.skills.map(s => skillLabels[s] || `Skill ${s}`).join(', ')}`).join('; ');
      const prompt = `${unassigned.size} of ${vrpJobs.length} delivery jobs could not be assigned. Unassigned jobs require these skills: ${[...new Set(unassignedSkills)].join(', ')}. Available fleet: ${vehicleSkills}. In 1-2 sentences explain why jobs are unassigned and what vehicles to add.`;
      sfQuery(`SELECT SNOWFLAKE.CORTEX.COMPLETE('claude-sonnet-4-5', '${prompt.replace(/'/g, "''")}') AS RESULT`).then(r => {
        try { setUnassignedExplanation((r[0]?.RESULT || '').replace(/```/g, '').trim()); } catch {}
      });
    }
    setSolving(false);
  }, [places, jobTemplates, vehicles, fetchDirections, maxJobs, selectedIndustry, regionName, skillLabels]);

  const assignmentMap = useMemo(() => {
    const m = new Map<string, JobAssignment>();
    for (const a of jobAssignments) m.set(`${a.lng.toFixed(6)},${a.lat.toFixed(6)}`, a);
    return m;
  }, [jobAssignments]);

  const unassignedCoords = useMemo(() => {
    const s = new Set<string>();
    for (const id of unassignedJobIds) {
      const place = places[id - 1];
      if (place) s.add(`${Number(place.LNG).toFixed(6)},${Number(place.LAT).toFixed(6)}`);
    }
    return s;
  }, [unassignedJobIds, places]);

  const basemap = useMemo(() => cartoBasemap(), []);

  const dataLayers = useMemo(() => {
    const result: any[] = [];
    if (showCatchment && catchmentGeoJson) {
      result.push(new GeoJsonLayer({ id: 'catchment', data: catchmentGeoJson, filled: true, stroked: true, getFillColor: [41, 181, 232, 40], getLineColor: [41, 181, 232, 180], lineWidthMinPixels: 2 }));
    }
    if (showRoutes) {
      routePaths.forEach((rp, i) => {
        const c = ROUTE_COLORS[rp.vehicleIdx % ROUTE_COLORS.length];
        result.push(new GeoJsonLayer({ id: `route-${i}`, data: rp.geojson, stroked: true, filled: false, getLineColor: [...c, 200], lineWidthMinPixels: 3 }));
      });
    }
    if (showPOIs && places.length) {
      const visiblePlaces = vrpResult ? places.slice(0, maxJobs) : places;
      const placeData = visiblePlaces.filter((p: any) => p.LNG && p.LAT).map((p: any) => {
        const key = `${Number(p.LNG).toFixed(6)},${Number(p.LAT).toFixed(6)}`;
        const assignment = assignmentMap.get(key);
        const isUnassigned = unassignedCoords.has(key);
        return { ...p, _vehicleIdx: assignment?.vehicleIdx ?? -1, _unassigned: isUnassigned };
      });
      result.push(new ScatterplotLayer({
        id: 'places', data: placeData,
        getPosition: (d: any) => [Number(d.LNG), Number(d.LAT)],
        getFillColor: (d: any) => {
          if (d._unassigned) return [30, 30, 30, 220];
          if (d._vehicleIdx >= 0) return [...ROUTE_COLORS[d._vehicleIdx % ROUTE_COLORS.length], 220] as any;
          return [41, 181, 232, 220];
        },
        getLineColor: (d: any) => d._unassigned ? [255, 60, 60, 200] : [255, 255, 255, 100],
        getRadius: 12, radiusMinPixels: 5, radiusMaxPixels: 14, pickable: true,
        stroked: true, lineWidthMinPixels: 1,
      }));
    }
    if (showDepot) {
      const depotData = selectedSchools.length > 0
        ? selectedSchools.map((s: any) => ({ lng: Number(s.LNG), lat: Number(s.LAT), name: s.NAME }))
        : centerCoords ? [{ lng: centerCoords[0], lat: centerCoords[1], name: 'Depot' }] : [];
      if (depotData.length > 0) {
        result.push(new ScatterplotLayer({ id: 'depot', data: depotData, getPosition: (d: any) => [d.lng, d.lat], getFillColor: [245, 158, 11, 255], getLineColor: [255, 255, 255, 255], getRadius: 80, radiusMinPixels: 10, stroked: true, lineWidthMinPixels: 3, pickable: true }));
      }
    }
    return result;
  }, [showCatchment, showRoutes, showPOIs, showDepot, catchmentGeoJson, routePaths, places, centerCoords, assignmentMap, unassignedCoords, vrpResult, selectedSchools, maxJobs]);

  const layers = useMemo(() => [basemap, ...dataLayers].filter(Boolean), [basemap, dataLayers]);

  const fitCoords = useMemo<LngLat[]>(() => {
    const out: LngLat[] = [];
    if (centerCoords) out.push([centerCoords[0], centerCoords[1]]);
    for (const s of selectedSchools) {
      const lng = Number(s.LNG); const lat = Number(s.LAT);
      if (Number.isFinite(lng) && Number.isFinite(lat)) out.push([lng, lat]);
    }
    for (const p of places) {
      const lng = Number(p.LNG); const lat = Number(p.LAT);
      if (Number.isFinite(lng) && Number.isFinite(lat)) out.push([lng, lat]);
    }
    if (catchmentGeoJson) out.push(...coordsFromGeoJSON(catchmentGeoJson));
    for (const rp of routePaths) if (rp.geojson) out.push(...coordsFromGeoJSON(rp.geojson));
    return out;
  }, [centerCoords, selectedSchools, places, catchmentGeoJson, routePaths]);

  const fallback = useMemo(() => {
    const lng = Number(center.lng);
    const lat = Number(center.lat);
    const z = Number(zoom);
    // Region-agnostic fallback: when there is no active region or the picker
    // hasn't supplied a centroid yet, show a world view rather than baking in
    // a city-specific default.
    const haveRegionCenter = Number.isFinite(lng) && Number.isFinite(lat) && (lng !== 0 || lat !== 0);
    return {
      longitude: haveRegionCenter ? lng : 0,
      latitude: haveRegionCenter ? lat : 0,
      zoom: Number.isFinite(z) && z > 0 ? z : (haveRegionCenter ? 11 : 2),
      pitch: 0, bearing: 0,
    };
  }, [center.lng, center.lat, zoom]);

  const { containerRef: mapContainerRef, dims: mapDims, viewState, onViewStateChange, recenter } = useFitMap(fitCoords, { fallback, regionKey: regionName });

  const getTooltip = useCallback(({ object }: any) => {
    if (!object) return null;
    if (object.name && !object.NAME) {
      return { html: `<div style="margin-bottom:4px"><b style="font-size:13px">${object.name}</b></div><div style="opacity:0.7">${depotLabel}</div>`, style: { backgroundColor: '#14141f', color: '#e8e8f0', padding: '12px 14px', borderRadius: '8px', fontSize: '12px', lineHeight: '1.6', maxWidth: '280px', boxShadow: '0 4px 12px rgba(0,0,0,0.3)' } };
    }
    if (!object.NAME) return null;
    const key = `${Number(object.LNG).toFixed(6)},${Number(object.LAT).toFixed(6)}`;
    const assignment = assignmentMap.get(key);
    const isUnassigned = unassignedCoords.has(key);
    let addr = object.DISPLAY_ADDRESS || '';
    if (!addr) {
      try {
        if (object.ADDRESS) {
          const a = typeof object.ADDRESS === 'string' ? JSON.parse(object.ADDRESS) : object.ADDRESS;
          addr = a?.freeform || '';
          if (a?.locality) addr += `, ${a.locality}`;
        }
      } catch {}
    }
    const isOverride = object.CATEGORY === 'student_pickup';
    const displayName = isOverride ? (addr || object.NAME) : object.NAME;
    const displayCategory = isOverride ? 'Student Pickup' : (object.CATEGORY || '');
    let html = `<div style="margin-bottom:4px"><b style="font-size:13px">${displayName}</b></div>`;
    html += `<div style="opacity:0.7;margin-bottom:2px">${displayCategory}</div>`;
    if (!isOverride && addr) html += `<div style="opacity:0.8;margin-bottom:4px">\u{1F4CD} ${addr}</div>`;
    if (isUnassigned) {
      const idx = places.findIndex((p: any) => `${Number(p.LNG).toFixed(6)},${Number(p.LAT).toFixed(6)}` === key);
      const jt = jobTemplates[idx % (jobTemplates.length || 1)];
      const reqSkills = jt?.skills?.map((s: number) => skillLabels[s] || `Skill ${s}`).join(', ') || 'Unknown';
      html += `<div style="margin-top:6px;padding-top:6px;border-top:1px solid rgba(255,60,60,0.4)">`;
      html += `<div style="color:#ff6b6b;font-weight:600;margin-bottom:3px">\u{26A0}\u{FE0F} Unassigned</div>`;
      html += `<div style="opacity:0.8">Requires: ${reqSkills}</div>`;
      html += `<div style="opacity:0.6;font-size:11px">No vehicle with matching skills</div>`;
      html += `</div>`;
    } else if (assignment) {
      const c = ROUTE_COLORS[assignment.vehicleIdx % ROUTE_COLORS.length];
      const label = PROFILE_LABELS[vehicles[assignment.vehicleIdx]?.profile] || 'Vehicle';
      html += `<div style="margin-top:6px;padding-top:6px;border-top:1px solid rgba(255,255,255,0.15)">`;
      html += `<div style="margin-bottom:3px"><span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:rgb(${c.join(',')});margin-right:6px"></span><b>${label} ${assignment.vehicleIdx + 1}</b> - Stop ${assignment.sequence} of ${assignment.totalStops}</div>`;
      if (assignment.timeWindow) html += `<div style="opacity:0.8">\u{1F550} ${assignment.timeWindow}</div>`;
      if (assignment.arrival != null) {
        const mins = Math.round(assignment.arrival / 60);
        html += `<div style="opacity:0.8">\u{23F1}\u{FE0F} ETA +${mins >= 60 ? `${Math.floor(mins / 60)}h ${mins % 60}m` : `${mins}m`}</div>`;
      }
      if (assignment.skills) html += `<div style="opacity:0.8">\u{1F4E6} ${assignment.skills}</div>`;
      html += `</div>`;
    }
    return { html, style: { backgroundColor: '#14141f', color: '#e8e8f0', padding: '12px 14px', borderRadius: '8px', fontSize: '12px', lineHeight: '1.6', maxWidth: '280px', boxShadow: '0 4px 12px rgba(0,0,0,0.3)' } };
  }, [assignmentMap, unassignedCoords, vehicles, places, jobTemplates, depotLabel, skillLabels]);

  const formatDist = (m: number) => m >= 1000 ? `${(m / 1000).toFixed(1)} km` : `${Math.round(m)} m`;
  const formatTime = (s: number) => { const min = Math.round(s / 60); return min >= 60 ? `${Math.floor(min / 60)}h ${min % 60}m` : `${min} min`; };

  return (
    <div className="panel">
      <h2 style={{ fontSize: 20, marginBottom: 4 }}>Route Optimization</h2>
      <p className="subtitle">VRP solver with ORS isochrones and directions</p>

      <div style={{ display: 'flex', gap: 12, marginBottom: 12, flexWrap: 'wrap', alignItems: 'flex-end' }}>
        <div style={{ minWidth: 140 }}>
          <label className="range-label">Industry</label>
          <select className="select" value={selectedIndustry} onChange={e => setSelectedIndustry(e.target.value)}>
            <option value="" disabled>Select industry...</option>
            {industries.map(i => <option key={i.INDUSTRY} value={i.INDUSTRY}>{i.INDUSTRY}</option>)}
          </select>
        </div>
        <div style={{ minWidth: 160 }}>
          <label className="range-label">Radius: {radius} km</label>
          <input type="range" min={1} max={20} value={radius} onChange={e => setRadius(Number(e.target.value))} style={{ width: '100%' }} />
        </div>
        <div style={{ flex: 1, minWidth: 200 }}>
          <label className="range-label">Search Location</label>
          <div style={{ display: 'flex', gap: 8 }}>
            <input className="select" value={searchText} onChange={e => setSearchText(e.target.value)} onKeyDown={e => e.key === 'Enter' && geocode()} placeholder="Enter address or city..." style={{ flex: 1 }} />
            <button className="btn-primary" onClick={geocode} disabled={geocoding}>{geocoding ? '...' : 'Go'}</button>
          </div>
        </div>
      </div>

      {loadingPresetData && (
        <div className="info-box" style={{ background: 'rgba(41,181,232,0.10)', color: '#0e7490', border: '1px solid rgba(41,181,232,0.4)', padding: 8, borderRadius: 6, marginBottom: 12, fontSize: 12 }}>
          Loading preset-backed data for <b>{regionName}</b>...
        </div>
      )}

      {centerCoords && !loading && !loadingPresetData && industries.length > 0 && places.length === 0 && (
        <div className="info-box" style={{ background: 'rgba(245,158,11,0.12)', color: '#a16207', border: '1px solid rgba(245,158,11,0.4)', padding: 8, borderRadius: 6, marginBottom: 12, fontSize: 12 }}>
          No preset data found for region <b>{regionName}</b> within {radius} km of this location. Run Data Studio for this preset, then retry.
        </div>
      )}

      <div className="metric-grid">
        <MetricCard label="Places" value={places.length} />
        <MetricCard label="Job Templates" value={jobTemplates.length} />
        <MetricCard label="Vehicles" value={vehicles.length} />
        {unassignedJobIds.size > 0 && <MetricCard label="Unassigned" value={unassignedJobIds.size} />}
      </div>

      {nearbySchools.length > 0 && (
        <div style={{ marginBottom: 12, padding: 10, borderRadius: 8, border: '1px solid var(--border)', background: 'rgba(0,0,0,0.02)' }}>
          <label style={{ fontSize: 12, fontWeight: 600, marginBottom: 6, display: 'block' }}>{depotLabel} - select one or more:</label>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
            {nearbySchools.map((s: any) => {
              const isSelected = selectedSchools.some((ss: any) => ss.NAME === s.NAME);
              return (
                <label key={s.NAME} style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 11, cursor: 'pointer', padding: '3px 8px', borderRadius: 4, border: isSelected ? '1px solid #F59E0B' : '1px solid var(--border)', background: isSelected ? 'rgba(245,158,11,0.1)' : 'transparent' }}>
                  <input type="checkbox" checked={isSelected} onChange={() => {
                    const updated = isSelected ? selectedSchools.filter((ss: any) => ss.NAME !== s.NAME) : [...selectedSchools, s];
                    setSelectedSchools(updated);
                    if (updated.length > 0) {
                      const primary = updated[0];
                      setVehicles(prev => prev.map(v => ({ ...v, startLng: Number(primary.LNG), startLat: Number(primary.LAT), endLng: Number(primary.LNG), endLat: Number(primary.LAT) })));
                    }
                  }} style={{ width: 12, height: 12 }} />
                  {s.NAME}
                </label>
              );
            })}
          </div>
        </div>
      )}

      {fleetRecommendation && fleetRecommendation.length > 0 && (
        <div style={{ marginBottom: 12, padding: 12, borderRadius: 8, border: '1px solid #29B5E8', background: 'rgba(41,181,232,0.05)' }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 6 }}>
            <span style={{ fontSize: 12, fontWeight: 600 }}>Fleet Recommendation</span>
            <button onClick={() => { const depot = selectedSchools[0]; const vecs = fleetRecommendation.map(v => depot ? { ...v, startLng: Number(depot.LNG), startLat: Number(depot.LAT), endLng: Number(depot.LNG), endLat: Number(depot.LAT) } : v); setVehicles(vecs); }} style={{ fontSize: 11, padding: '3px 10px', background: '#29B5E8', color: '#fff', border: 'none', borderRadius: 4, cursor: 'pointer' }}>Apply</button>
          </div>
          <div style={{ fontSize: 11, opacity: 0.8 }}>
            Based on your job templates, you need:{' '}
            {(() => {
              const counts: Record<string, number> = {};
              fleetRecommendation.forEach(v => {
                const label = v.skills.map(s => skillLabels[s] || `Skill ${s}`).join(' + ');
                counts[label] = (counts[label] || 0) + 1;
              });
              return Object.entries(counts).map(([label, count]) => `${count}x ${label} (cap: ${fleetRecommendation.find(fr => fr.skills.some(s => skillLabels[s] === label.split(' + ')[0]))?.capacity || '?'})`).join(', ');
            })()}
          </div>
        </div>
      )}

      <div style={{ display: 'flex', gap: 8, marginBottom: 12, flexWrap: 'wrap' }}>
        <button className="btn-primary" onClick={() => setShowVehicleBuilder(!showVehicleBuilder)} style={{ fontSize: 12 }}>{showVehicleBuilder ? 'Hide' : 'Show'} Vehicle Builder</button>
        <button className="btn-primary" onClick={() => setShowJobTemplates(!showJobTemplates)} style={{ fontSize: 12 }}>{showJobTemplates ? 'Hide' : 'Show'} Job Templates</button>
        <button className="btn-primary" onClick={previewCatchment} disabled={!centerCoords} style={{ fontSize: 12 }}>Preview Catchment ({isoMinutes}m)</button>
        <div style={{ minWidth: 120 }}>
          <input type="range" min={5} max={60} step={5} value={isoMinutes} onChange={e => setIsoMinutes(Number(e.target.value))} style={{ width: '100%' }} />
        </div>
        <button
          className="btn-primary"
          onClick={optimizeRoutes}
          disabled={solving || !places.length || !availableProfiles.length}
          title={
            solving ? 'Solving...'
            : !centerCoords ? 'Search a location first (enter an address and click Go)'
            : !places.length ? `No places found for region '${regionName}' near this location. Try a different region or address.`
            : !availableProfiles.length ? `ORS service for region '${regionName}' is not ready or has no profiles loaded. Wait for the region to finish provisioning, then refresh.`
            : 'Optimize delivery routes'
          }
          style={{ fontSize: 12, background: '#0DB048' }}
        >
          {solving ? 'Solving...' : 'Optimize Routes'}
        </button>
      </div>

      {showVehicleBuilder && (
        <div style={{ marginBottom: 12, padding: 12, borderRadius: 8, border: '1px solid var(--border)', background: 'rgba(0,0,0,0.02)' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
            <h3 style={{ fontSize: 13, margin: 0 }}>Vehicle Builder</h3>
            <button onClick={() => setVehicles(prev => [...prev, { id: prev.length + 1, profile: availableProfiles.includes(preset.orsProfile) ? preset.orsProfile : (availableProfiles[0] || preset.orsProfile), skills: [1], startLng: vehicleHomeCoords[0], startLat: vehicleHomeCoords[1], endLng: vehicleHomeCoords[0], endLat: vehicleHomeCoords[1], capacity: 10 }])} style={{ fontSize: 11, padding: '2px 8px', border: '1px solid var(--border)', borderRadius: 4, background: 'transparent', cursor: 'pointer' }}>+ Add Vehicle</button>
          </div>
          {vehicles.map((v, i) => (
            <div key={v.id} style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 6, fontSize: 12, flexWrap: 'wrap' }}>
              <span style={{ width: 12, height: 12, borderRadius: '50%', background: `rgb(${ROUTE_COLORS[i % ROUTE_COLORS.length].join(',')})`, flexShrink: 0 }} />
              <select className="select" value={v.profile} disabled={!availableProfiles.length} onChange={e => setVehicles(prev => prev.map((vv, ii) => ii === i ? { ...vv, profile: e.target.value } : vv))} style={{ width: 120 }}>
                {availableProfiles.length === 0 && <option value="">-</option>}
                {availableProfiles.map(p => <option key={p} value={p}>{PROFILE_LABELS[p] ?? p}</option>)}
              </select>
              <span style={{ color: 'var(--text-secondary)', fontSize: 11 }}>Cap:</span>
              <input type="number" value={v.capacity} onChange={e => setVehicles(prev => prev.map((vv, ii) => ii === i ? { ...vv, capacity: Number(e.target.value) } : vv))} style={{ width: 45 }} />
              <span style={{ color: 'var(--text-secondary)', fontSize: 11 }}>Skills:</span>
              <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
                {Object.entries(skillLabels).map(([numStr, label]) => {
                  const num = Number(numStr);
                  const active = v.skills.includes(num);
                  return (
                    <button key={num} onClick={() => setVehicles(prev => prev.map((vv, ii) => { if (ii !== i) return vv; const newSkills = active ? vv.skills.filter(s => s !== num) : [...vv.skills, num]; const primarySkill = newSkills[newSkills.length - 1]; return { ...vv, skills: newSkills, capacity: skillCapacity[primarySkill] || SKILL_CAPACITY[primarySkill] || vv.capacity }; }))} style={{ fontSize: 10, padding: '2px 6px', borderRadius: 3, border: active ? '1px solid #29B5E8' : '1px solid var(--border)', background: active ? 'rgba(41,181,232,0.15)' : 'transparent', color: active ? '#29B5E8' : 'var(--text-secondary)', cursor: 'pointer' }}>{label.split(' ')[0]}</button>
                  );
                })}
              </div>
              {vehicles.length > 1 && <button onClick={() => setVehicles(prev => prev.filter((_, ii) => ii !== i))} style={{ fontSize: 11, color: '#E5484D', background: 'transparent', border: 'none', cursor: 'pointer' }}>x</button>}
            </div>
          ))}
        </div>
      )}

      {showJobTemplates && (
        <div style={{ marginBottom: 12, padding: 12, borderRadius: 8, border: '1px solid var(--border)', background: 'rgba(0,0,0,0.02)' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 8 }}>
            <h3 style={{ fontSize: 13, margin: 0 }}>Job Templates</h3>
            <span style={{ fontSize: 11, color: 'var(--text-secondary)' }}>Max jobs:</span>
            <input type="number" value={maxJobs} onChange={e => setMaxJobs(Math.max(1, Math.min(200, Number(e.target.value))))} style={{ width: 50, fontSize: 11 }} min={1} max={200} />
          </div>
          <div style={{ maxHeight: 200, overflowY: 'auto' }}>
            {jobTemplates.map((jt, i) => (
              <div key={jt.id} style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 6, fontSize: 11, flexWrap: 'wrap', padding: '4px 0', borderBottom: i < jobTemplates.length - 1 ? '1px solid var(--border)' : 'none' }}>
                <span style={{ fontWeight: 500, minWidth: 100 }}>{jt.product || jt.industry}</span>
                <span style={{ color: 'var(--text-secondary)' }}>Window:</span>
                <input type="time" value={jt.slotStart} onChange={e => setJobTemplates(prev => prev.map((t, ii) => ii === i ? { ...t, slotStart: e.target.value } : t))} style={{ width: 80, fontSize: 11 }} />
                <span>-</span>
                <input type="time" value={jt.slotEnd} onChange={e => setJobTemplates(prev => prev.map((t, ii) => ii === i ? { ...t, slotEnd: e.target.value } : t))} style={{ width: 80, fontSize: 11 }} />
                <span style={{ color: 'var(--text-secondary)' }}>Dur:</span>
                <input type="number" value={jt.serviceDuration} onChange={e => setJobTemplates(prev => prev.map((t, ii) => ii === i ? { ...t, serviceDuration: Number(e.target.value) } : t))} style={{ width: 40, fontSize: 11 }} min={1} max={120} />
                <span style={{ fontSize: 10, opacity: 0.6 }}>min</span>
                <select value={jt.skills[0] || 1} onChange={e => setJobTemplates(prev => prev.map((t, ii) => ii === i ? { ...t, skills: [Number(e.target.value)] } : t))} style={{ fontSize: 11, width: 90 }}>
                  {Object.entries(skillLabels).map(([n, l]) => <option key={n} value={n}>{l.split('/')[0].trim()}</option>)}
                </select>
              </div>
            ))}
          </div>
          <div style={{ marginTop: 10, display: 'flex', alignItems: 'center', gap: 10 }}>
            <button className="btn-primary" onClick={() => { setFleetRecommendation(null); setTimeout(() => { const jobCount = Math.min(places.length, maxJobs); const skillCounts: Record<number, number> = {}; for (let i = 0; i < jobCount; i++) { const jt = jobTemplates[i % jobTemplates.length]; jt.skills.forEach(s => { skillCounts[s] = (skillCounts[s] || 0) + 1; }); } const recommended: VehicleConfig[] = []; let id = 1; const baseProfile = availableProfiles.includes(preset.orsProfile) ? preset.orsProfile : (availableProfiles[0] || preset.orsProfile); for (const [skillStr, count] of Object.entries(skillCounts)) { const skill = Number(skillStr); const cap = skillCapacity[skill] || SKILL_CAPACITY[skill] || 10; const numVehicles = Math.max(1, Math.ceil(count / cap)); for (let i = 0; i < numVehicles; i++) { recommended.push({ id: id++, profile: baseProfile, skills: [skill], startLng: vehicleHomeCoords[0], startLat: vehicleHomeCoords[1], endLng: vehicleHomeCoords[0], endLat: vehicleHomeCoords[1], capacity: cap }); } } setFleetRecommendation(recommended); }, 0); }} disabled={!jobTemplates.length} style={{ fontSize: 12 }}>Apply Templates</button>
            <span style={{ fontSize: 11, opacity: 0.6 }}>{Math.min(places.length, maxJobs)} jobs will be sent to solver</span>
          </div>
        </div>
      )}

      {unassignedJobIds.size > 0 && (
        <div style={{ marginBottom: 12, padding: 10, borderRadius: 8, border: '1px solid #E5484D', background: 'rgba(229,72,77,0.05)', fontSize: 12 }}>
          <div style={{ fontWeight: 600, marginBottom: 4, color: '#E5484D' }}>{unassignedJobIds.size} of {Math.min(places.length, maxJobs)} jobs unassigned</div>
          {unassignedExplanation && <div style={{ opacity: 0.85, lineHeight: 1.4 }}>{unassignedExplanation}</div>}
        </div>
      )}

      {vrpResult && (
        <>
          <div className="info-box success" style={{ marginBottom: 8 }}>
            Solution: {routePaths.length} routes, {jobAssignments.length} assigned{loadingDirections ? ' - fetching directions...' : ''}
          </div>
          <div style={{ display: 'flex', gap: 0, marginBottom: 12 }}>
            <button onClick={() => setActiveResultTab('map')} style={{ padding: '6px 16px', fontSize: 12, fontWeight: activeResultTab === 'map' ? 600 : 400, background: activeResultTab === 'map' ? 'var(--accent, #29B5E8)' : 'transparent', color: activeResultTab === 'map' ? '#fff' : 'var(--text-primary)', border: '1px solid var(--border)', borderRadius: '6px 0 0 6px', cursor: 'pointer' }}>Map</button>
            <button onClick={() => setActiveResultTab('assignments')} style={{ padding: '6px 16px', fontSize: 12, fontWeight: activeResultTab === 'assignments' ? 600 : 400, background: activeResultTab === 'assignments' ? 'var(--accent, #29B5E8)' : 'transparent', color: activeResultTab === 'assignments' ? '#fff' : 'var(--text-primary)', border: '1px solid var(--border)', borderLeft: 'none', borderRadius: '0 6px 6px 0', cursor: 'pointer' }}>Job Assignments</button>
          </div>
        </>
      )}

      <div style={{ display: (!vrpResult || activeResultTab === 'map') ? 'block' : 'none' }}>
        <div ref={mapContainerRef} style={{ height: 500, borderRadius: 8, border: '1px solid var(--border)', overflow: 'hidden', position: 'relative', background: '#e8e8e8' }}>
          {(loading || solving) && <div style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, background: 'rgba(0,0,0,0.5)', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#fff', zIndex: 10, fontSize: 14 }}>{solving ? 'Solving VRP...' : 'Loading...'}</div>}
          <div style={{ position: 'absolute', top: 56, right: 12, zIndex: 5, background: 'rgba(20,20,31,0.85)', borderRadius: 8, padding: '8px 12px', fontSize: 11, color: '#e8e8f0', backdropFilter: 'blur(4px)', boxShadow: '0 2px 8px rgba(0,0,0,0.3)' }}>
            <div style={{ fontWeight: 600, marginBottom: 4, fontSize: 10, textTransform: 'uppercase', opacity: 0.6 }}>Layers</div>
            {[
              { label: 'POI Locations', checked: showPOIs, set: setShowPOIs, color: '#29B5E8' },
              { label: 'Route Lines', checked: showRoutes, set: setShowRoutes, color: '#22C55E' },
              { label: 'Catchment', checked: showCatchment, set: setShowCatchment, color: '#29B5E8' },
              { label: depotLabel, checked: showDepot, set: setShowDepot, color: '#F59E0B' },
            ].map(layer => (
              <label key={layer.label} style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer', padding: '2px 0' }}>
                <input type="checkbox" checked={layer.checked} onChange={e => layer.set(e.target.checked)} style={{ accentColor: layer.color, width: 12, height: 12 }} />
                <span style={{ opacity: layer.checked ? 1 : 0.5 }}>{layer.label}</span>
              </label>
            ))}
          </div>
          {mapDims && <DeckGL width={mapDims.width} height={mapDims.height} viewState={viewState} onViewStateChange={onViewStateChange} controller={true} layers={layers} getTooltip={getTooltip} style={{ position: 'absolute', top: '0', left: '0', width: `${mapDims.width}px`, height: `${mapDims.height}px` }} />}
          <RecenterButton onClick={recenter} disabled={!fitCoords.length} />
        </div>
      </div>

      {vrpResult && activeResultTab === 'assignments' && (
        <div style={{ borderRadius: 8, border: '1px solid var(--border)', overflow: 'hidden' }}>
          <table style={{ width: '100%', fontSize: 12, borderCollapse: 'collapse' }}>
            <thead>
              <tr style={{ background: 'var(--bg-secondary, #f5f5f5)', borderBottom: '1px solid var(--border)' }}>
                <th style={{ padding: '8px 10px', textAlign: 'left', fontWeight: 600 }}>Stop</th>
                <th style={{ padding: '8px 10px', textAlign: 'left', fontWeight: 600 }}>Vehicle</th>
                <th style={{ padding: '8px 10px', textAlign: 'left', fontWeight: 600 }}>Place</th>
                <th style={{ padding: '8px 10px', textAlign: 'left', fontWeight: 600 }}>Address</th>
                <th style={{ padding: '8px 10px', textAlign: 'left', fontWeight: 600 }}>Window</th>
                <th style={{ padding: '8px 10px', textAlign: 'left', fontWeight: 600 }}>ETA</th>
              </tr>
            </thead>
            <tbody>
              {jobAssignments.sort((a, b) => a.vehicleIdx - b.vehicleIdx || (a.sequence || 0) - (b.sequence || 0)).map((a, i) => {
                const c = ROUTE_COLORS[a.vehicleIdx % ROUTE_COLORS.length];
                const etaMins = a.arrival != null ? Math.round(a.arrival / 60) : null;
                return (
                  <tr key={i} style={{ borderBottom: '1px solid var(--border)', background: `rgba(${c[0]},${c[1]},${c[2]},0.05)` }}>
                    <td style={{ padding: '6px 10px', fontWeight: 500 }}>{a.sequence || i + 1}/{a.totalStops || '?'}</td>
                    <td style={{ padding: '6px 10px' }}>
                      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                        <span style={{ width: 10, height: 10, borderRadius: '50%', background: `rgb(${c.join(',')})`, flexShrink: 0 }} />
                        {PROFILE_LABELS[vehicles[a.vehicleIdx]?.profile] || 'Vehicle'} {a.vehicleIdx + 1}
                      </span>
                    </td>
                    <td style={{ padding: '6px 10px' }}><span style={{ fontWeight: 500 }}>{a.placeName}</span><br /><span style={{ opacity: 0.6, fontSize: 11 }}>{a.category}</span></td>
                    <td style={{ padding: '6px 10px', opacity: 0.8, fontSize: 11 }}>{a.address || '-'}</td>
                    <td style={{ padding: '6px 10px', fontSize: 11 }}>{a.timeWindow || '-'}</td>
                    <td style={{ padding: '6px 10px', fontSize: 11 }}>{etaMins != null ? (etaMins >= 60 ? `${Math.floor(etaMins / 60)}h ${etaMins % 60}m` : `${etaMins}m`) : '-'}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>

          {routeDirections.length > 0 && (
            <div style={{ padding: 12, borderTop: '1px solid var(--border)' }}>
              <h4 style={{ fontSize: 13, marginBottom: 8, fontWeight: 600 }}>Turn-by-Turn Directions</h4>
              {routeDirections.map(rd => {
                const c = ROUTE_COLORS[rd.vehicleIdx % ROUTE_COLORS.length];
                const isExpanded = expandedRoute === rd.vehicleIdx;
                return (
                  <div key={rd.vehicleIdx} style={{ marginBottom: 8, borderRadius: 6, border: '1px solid var(--border)', overflow: 'hidden' }}>
                    <button onClick={() => setExpandedRoute(isExpanded ? null : rd.vehicleIdx)} style={{ width: '100%', display: 'flex', alignItems: 'center', gap: 8, padding: '8px 12px', background: `rgba(${c[0]},${c[1]},${c[2]},0.08)`, border: 'none', cursor: 'pointer', fontSize: 12, textAlign: 'left' }}>
                      <span style={{ transform: isExpanded ? 'rotate(90deg)' : 'none', transition: 'transform 0.2s' }}>&#9654;</span>
                      <span style={{ width: 10, height: 10, borderRadius: '50%', background: `rgb(${c.join(',')})` }} />
                      <b>Vehicle {rd.vehicleIdx + 1}</b> ({PROFILE_LABELS[rd.profile] || rd.profile})
                      <span style={{ marginLeft: 'auto', opacity: 0.7 }}>{formatDist(rd.totalDistance)} &middot; {formatTime(rd.totalDuration)}</span>
                    </button>
                    {isExpanded && (
                      <div style={{ padding: '8px 12px', maxHeight: 300, overflowY: 'auto' }}>
                        {rd.steps.map((st, si) => (
                          <div key={si} style={{ display: 'flex', gap: 8, padding: '4px 0', borderBottom: si < rd.steps.length - 1 ? '1px solid var(--border)' : 'none', fontSize: 11 }}>
                            <span style={{ minWidth: 20, color: 'var(--text-secondary)', textAlign: 'right' }}>{si + 1}.</span>
                            <span style={{ flex: 1 }}>{st.instruction}</span>
                            <span style={{ opacity: 0.6, whiteSpace: 'nowrap' }}>{formatDist(st.distance)}</span>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
          {loadingDirections && (
            <div style={{ padding: 12, textAlign: 'center', fontSize: 12, opacity: 0.7 }}>Loading turn-by-turn directions...</div>
          )}
        </div>
      )}
    </div>
  );
}

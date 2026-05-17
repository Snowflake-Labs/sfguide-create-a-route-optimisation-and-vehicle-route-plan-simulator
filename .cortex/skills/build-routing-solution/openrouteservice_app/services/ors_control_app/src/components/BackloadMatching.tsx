import { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import MetricCard from '../shared/MetricCard';
import DeckGL from '@deck.gl/react';
import { ScatterplotLayer, GeoJsonLayer, IconLayer } from '@deck.gl/layers';
import { BitmapLayer } from '@deck.gl/layers';
import { TileLayer } from '@deck.gl/geo-layers';
import { useRegion } from '../hooks/useRegion';

const BM_DB = 'FLEET_INTELLIGENCE';
const BM_SCHEMA = 'BACKLOAD_MATCHING';
const CARTO_LIGHT = '/api/tiles/{z}/{x}/{y}';

const USE_MOCK = false;

const ROUTE_COLORS: [number, number, number][] = [
  [41, 181, 232], [34, 197, 94], [245, 158, 11], [239, 68, 68],
  [128, 0, 255], [255, 105, 180], [0, 191, 255], [50, 205, 50],
  [255, 165, 0], [220, 38, 38], [99, 102, 241], [16, 185, 129],
];

interface Trailer {
  TRAILER_ID: string; OPERATING_COUNTRY: string; HOME_DEPOT: string;
  HOME_LON: number; HOME_LAT: number; CURRENT_LOAD: string;
  DROPOFF_CITY: string; DROPOFF_LON: number; DROPOFF_LAT: number;
  ETA_TS: string; ETA_MIN: number; STATUS: string;
  HAZMAT_CERT: boolean; MAX_PAYLOAD_KG: number;
}

interface Volume {
  ID: string; PICKUP_CITY: string; PICKUP_LON: number; PICKUP_LAT: number;
  DROPOFF_CITY: string; DROPOFF_LON: number; DROPOFF_LAT: number;
  PICKUP_FROM_TS: string; PICKUP_TO_TS: string;
  WEIGHT_KG: number; PRODUCT: string; HAZMAT: boolean;
}

interface Offer extends Volume {
  OFFER_ID: string; SOURCE: string; PRICE_EUR: number;
  PICKUP_COUNTRY: string; DROPOFF_COUNTRY: string;
  LISTING_TEXT: string;
}

interface Assignment {
  TRAILER_ID: string; OFFER_ID: string; SOURCE: string;
  PICKUP_LON: number; PICKUP_LAT: number;
  DROPOFF_LON: number; DROPOFF_LAT: number;
  EMPTY_KM: number; LOADED_KM: number; SCORE: number;
  PRODUCT: string; PICKUP_CITY: string; PROPOSAL_DROPOFF_CITY: string;
  HOME_LON: number; HOME_LAT: number;
  TRAILER_DROPOFF_LON: number; TRAILER_DROPOFF_LAT: number;
  ROUTE_GEOJSON?: any;
  EMPTY_GEOJSON?: any;
}

const MOCK_TRAILERS: Trailer[] = [
  { TRAILER_ID:'TR-0001', OPERATING_COUNTRY:'DE', HOME_DEPOT:'Copenhagen', HOME_LON:12.5655, HOME_LAT:55.6759, CURRENT_LOAD:'Furniture parts', DROPOFF_CITY:'Cologne',   DROPOFF_LON:6.9603, DROPOFF_LAT:50.9375, ETA_TS:'2026-05-16T18:00:00', ETA_MIN:120, STATUS:'IN_TRANSIT', HAZMAT_CERT:true,  MAX_PAYLOAD_KG:24000 },
  { TRAILER_ID:'TR-0002', OPERATING_COUNTRY:'DE', HOME_DEPOT:'Stockholm',  HOME_LON:18.0686, HOME_LAT:59.3293, CURRENT_LOAD:'Auto components', DROPOFF_CITY:'Frankfurt', DROPOFF_LON:8.6821, DROPOFF_LAT:50.1109, ETA_TS:'2026-05-16T17:30:00', ETA_MIN: 90, STATUS:'IN_TRANSIT', HAZMAT_CERT:false, MAX_PAYLOAD_KG:22000 },
  { TRAILER_ID:'TR-0003', OPERATING_COUNTRY:'DE', HOME_DEPOT:'Helsinki',   HOME_LON:24.9384, HOME_LAT:60.1699, CURRENT_LOAD:'Pharma pallets',  DROPOFF_CITY:'Munich',    DROPOFF_LON:11.5820,DROPOFF_LAT:48.1351, ETA_TS:'2026-05-16T19:15:00', ETA_MIN:195, STATUS:'IN_TRANSIT', HAZMAT_CERT:false, MAX_PAYLOAD_KG:18000 },
  { TRAILER_ID:'TR-0004', OPERATING_COUNTRY:'DE', HOME_DEPOT:'Copenhagen', HOME_LON:12.5655, HOME_LAT:55.6759, CURRENT_LOAD:'Frozen food',     DROPOFF_CITY:'Hamburg',   DROPOFF_LON:9.9937, DROPOFF_LAT:53.5511, ETA_TS:'2026-05-16T16:45:00', ETA_MIN: 45, STATUS:'IN_TRANSIT', HAZMAT_CERT:false, MAX_PAYLOAD_KG:20000 },
  { TRAILER_ID:'TR-0005', OPERATING_COUNTRY:'DE', HOME_DEPOT:'Oslo',       HOME_LON:10.7522, HOME_LAT:59.9139, CURRENT_LOAD:'Industrial machinery', DROPOFF_CITY:'Dortmund', DROPOFF_LON:7.4653, DROPOFF_LAT:51.5136, ETA_TS:'2026-05-16T18:30:00', ETA_MIN:150, STATUS:'IN_TRANSIT', HAZMAT_CERT:true,  MAX_PAYLOAD_KG:26000 },
  { TRAILER_ID:'TR-0006', OPERATING_COUNTRY:'DE', HOME_DEPOT:'Stockholm',  HOME_LON:18.0686, HOME_LAT:59.3293, CURRENT_LOAD:'Furniture parts', DROPOFF_CITY:'Berlin',    DROPOFF_LON:13.4050,DROPOFF_LAT:52.5200, ETA_TS:'2026-05-16T17:00:00', ETA_MIN: 60, STATUS:'IN_TRANSIT', HAZMAT_CERT:false, MAX_PAYLOAD_KG:24000 },
  { TRAILER_ID:'TR-0007', OPERATING_COUNTRY:'DE', HOME_DEPOT:'Copenhagen', HOME_LON:12.5655, HOME_LAT:55.6759, CURRENT_LOAD:'Auto components', DROPOFF_CITY:'Hannover',  DROPOFF_LON:9.7320, DROPOFF_LAT:52.3759, ETA_TS:'2026-05-16T18:15:00', ETA_MIN:135, STATUS:'IN_TRANSIT', HAZMAT_CERT:false, MAX_PAYLOAD_KG:22000 },
  { TRAILER_ID:'TR-0008', OPERATING_COUNTRY:'DE', HOME_DEPOT:'Helsinki',   HOME_LON:24.9384, HOME_LAT:60.1699, CURRENT_LOAD:'Frozen food',     DROPOFF_CITY:'Bremen',    DROPOFF_LON:8.8017, DROPOFF_LAT:53.0793, ETA_TS:'2026-05-16T17:45:00', ETA_MIN:105, STATUS:'IN_TRANSIT', HAZMAT_CERT:false, MAX_PAYLOAD_KG:20000 },
  { TRAILER_ID:'TR-0009', OPERATING_COUNTRY:'DE', HOME_DEPOT:'Oslo',       HOME_LON:10.7522, HOME_LAT:59.9139, CURRENT_LOAD:'Pharma pallets',  DROPOFF_CITY:'Stuttgart', DROPOFF_LON:9.1829, DROPOFF_LAT:48.7758, ETA_TS:'2026-05-16T19:30:00', ETA_MIN:210, STATUS:'IN_TRANSIT', HAZMAT_CERT:true,  MAX_PAYLOAD_KG:18000 },
  { TRAILER_ID:'TR-0010', OPERATING_COUNTRY:'DE', HOME_DEPOT:'Copenhagen', HOME_LON:12.5655, HOME_LAT:55.6759, CURRENT_LOAD:'Industrial machinery', DROPOFF_CITY:'Leipzig', DROPOFF_LON:12.3731,DROPOFF_LAT:51.3397, ETA_TS:'2026-05-16T18:00:00', ETA_MIN:120, STATUS:'IN_TRANSIT', HAZMAT_CERT:false, MAX_PAYLOAD_KG:26000 },
  { TRAILER_ID:'TR-0011', OPERATING_COUNTRY:'DE', HOME_DEPOT:'Stockholm',  HOME_LON:18.0686, HOME_LAT:59.3293, CURRENT_LOAD:'Furniture parts', DROPOFF_CITY:'Nuremberg', DROPOFF_LON:11.0767,DROPOFF_LAT:49.4521, ETA_TS:'2026-05-16T19:00:00', ETA_MIN:180, STATUS:'IN_TRANSIT', HAZMAT_CERT:false, MAX_PAYLOAD_KG:24000 },
  { TRAILER_ID:'TR-0012', OPERATING_COUNTRY:'DE', HOME_DEPOT:'Copenhagen', HOME_LON:12.5655, HOME_LAT:55.6759, CURRENT_LOAD:'Auto components', DROPOFF_CITY:'Dresden',   DROPOFF_LON:13.7373,DROPOFF_LAT:51.0504, ETA_TS:'2026-05-16T18:45:00', ETA_MIN:165, STATUS:'IN_TRANSIT', HAZMAT_CERT:false, MAX_PAYLOAD_KG:22000 },
];

const DE_CITIES: { city: string; lon: number; lat: number }[] = [
  { city:'Hamburg',   lon:9.9937,  lat:53.5511 },
  { city:'Bremen',    lon:8.8017,  lat:53.0793 },
  { city:'Berlin',    lon:13.4050, lat:52.5200 },
  { city:'Hannover',  lon:9.7320,  lat:52.3759 },
  { city:'Dortmund',  lon:7.4653,  lat:51.5136 },
  { city:'Cologne',   lon:6.9603,  lat:50.9375 },
  { city:'Frankfurt', lon:8.6821,  lat:50.1109 },
  { city:'Leipzig',   lon:12.3731, lat:51.3397 },
  { city:'Dresden',   lon:13.7373, lat:51.0504 },
  { city:'Stuttgart', lon:9.1829,  lat:48.7758 },
  { city:'Nuremberg', lon:11.0767, lat:49.4521 },
  { city:'Munich',    lon:11.5820, lat:48.1351 },
];

function jitter(v: number, scale = 0.05): number { return v + (Math.random() - 0.5) * scale; }

function buildMockInternal(): Volume[] {
  const out: Volume[] = [];
  const products = ['DHL Express parcels','B2B pallets','Automotive parts','Pharma cold-chain','Retail e-commerce'];
  for (let i = 0; i < 18; i++) {
    const p = DE_CITIES[i % DE_CITIES.length];
    const d = DE_CITIES[(i * 7 + 3) % DE_CITIES.length];
    if (p.city === d.city) continue;
    const winStart = 60 + (i * 47) % 600;
    out.push({
      ID: `INT-${String(i + 1).padStart(5, '0')}`,
      PICKUP_CITY: p.city,
      PICKUP_LON: jitter(p.lon, 0.02), PICKUP_LAT: jitter(p.lat, 0.02),
      DROPOFF_CITY: d.city,
      DROPOFF_LON: jitter(d.lon, 0.02), DROPOFF_LAT: jitter(d.lat, 0.02),
      PICKUP_FROM_TS: new Date(Date.now() + winStart * 60_000).toISOString(),
      PICKUP_TO_TS: new Date(Date.now() + (winStart + 240) * 60_000).toISOString(),
      WEIGHT_KG: 5000 + (i * 1100) % 18000,
      PRODUCT: products[i % products.length],
      HAZMAT: false,
    });
  }
  return out;
}

function buildMockExternal(): Offer[] {
  const out: Offer[] = [];
  const sources = ['TIMOCOM','WTRANSNET','TELEROUTE','B2P'];
  const products = ['Pallets (general)','Steel coils','Plastic granulate','Beverages','Furniture','Bulk paper'];
  for (let i = 0; i < 30; i++) {
    const p = DE_CITIES[(i * 5 + 1) % DE_CITIES.length];
    const d = DE_CITIES[(i * 11 + 7) % DE_CITIES.length];
    if (p.city === d.city) continue;
    const src = sources[i % sources.length];
    const prod = products[i % products.length];
    const wt = 800 + (i * 691) % 24000;
    const price = 400 + (i * 137) % 4000;
    const winStart = 60 + (i * 73) % 1100;
    const haz = i % 13 === 0;
    out.push({
      ID: '',
      OFFER_ID: `OFF-${String(i + 1).padStart(6, '0')}`,
      SOURCE: src,
      PICKUP_CITY: p.city, PICKUP_COUNTRY: 'DE',
      PICKUP_LON: jitter(p.lon, 0.04), PICKUP_LAT: jitter(p.lat, 0.04),
      DROPOFF_CITY: d.city, DROPOFF_COUNTRY: 'DE',
      DROPOFF_LON: jitter(d.lon, 0.04), DROPOFF_LAT: jitter(d.lat, 0.04),
      PICKUP_FROM_TS: new Date(Date.now() + winStart * 60_000).toISOString(),
      PICKUP_TO_TS: new Date(Date.now() + (winStart + 240) * 60_000).toISOString(),
      WEIGHT_KG: wt,
      PRODUCT: prod,
      PRICE_EUR: price,
      HAZMAT: haz,
      LISTING_TEXT: `${src} - ${p.city} -> ${d.city} - ${wt} kg - ${prod} - EUR ${price}${haz ? ' - ADR' : ''}`,
    });
  }
  return out;
}

async function sfQuery(sql: string, database = BM_DB, schema = BM_SCHEMA): Promise<any[]> {
  try {
    const res = await fetch('/api/query', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sql, database, schema }) });
    const body = await res.json();
    const rows = Array.isArray(body) ? body : (body.result ?? []);
    return Array.isArray(rows) ? rows : [];
  } catch (err) {
    console.error('[BM/sfQuery] Error:', err, 'SQL:', sql.slice(0, 300));
    return [];
  }
}

function cartoBasemap() {
  return new TileLayer({
    id: 'carto-basemap', data: CARTO_LIGHT, minZoom: 0, maxZoom: 19, tileSize: 256,
    renderSubLayers: (props: any) => {
      const { boundingBox } = props.tile;
      return new BitmapLayer(props, { data: undefined, image: props.data, bounds: [boundingBox[0][0], boundingBox[0][1], boundingBox[1][0], boundingBox[1][1]] });
    },
  });
}

function haversineKm(lon1: number, lat1: number, lon2: number, lat2: number): number {
  const R = 6371, toRad = (x: number) => x * Math.PI / 180;
  const dLat = toRad(lat2 - lat1), dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

export default function BackloadMatching() {
  const { regionName, center, zoom } = useRegion();
  const [trailers, setTrailers] = useState<Trailer[]>([]);
  const [internal, setInternal] = useState<Volume[]>([]);
  const [external, setExternal] = useState<Offer[]>([]);

  const [internalPriority, setInternalPriority] = useState(100);
  const [externalPriority, setExternalPriority] = useState(10);
  const [windowToleranceHrs, setWindowToleranceHrs] = useState(4);
  const [maxEmptyKm, setMaxEmptyKm] = useState(200);

  const [solving, setSolving] = useState(false);
  const [assignments, setAssignments] = useState<Assignment[]>([]);
  const emptyLegCacheRef = useRef<Map<string, any>>(new Map());
  const [unassigned, setUnassigned] = useState<{ id: number; reason?: string }[]>([]);
  const [selectedTrailer, setSelectedTrailer] = useState<string | null>(null);
  const [rationale, setRationale] = useState<Record<string, string>>({});
  const [rationaleLoading, setRationaleLoading] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [confirmMsg, setConfirmMsg] = useState<string | null>(null);
  const [seedHint, setSeedHint] = useState<string | null>(null);
  const [solverLog, setSolverLog] = useState<string | null>(null);

  // ORS service status + wake-up
  interface SvcStatus { name: string; status: string; cur: number; tgt: number; }
  const requiredServices = useMemo(
    () => ['VROOM_SERVICE', 'ROUTING_GATEWAY_SERVICE', 'ORS_SERVICE', `ORS_SERVICE_${(regionName || '').toUpperCase()}`],
    [regionName]
  );
  const [svcStatus, setSvcStatus] = useState<SvcStatus[]>([]);
  const [wakingUp, setWakingUp] = useState(false);

  const fetchSvcStatus = useCallback(async (): Promise<SvcStatus[]> => {
    await sfQuery(`SHOW SERVICES IN DATABASE OPENROUTESERVICE_APP`, 'OPENROUTESERVICE_APP', 'CORE');
    const filterList = requiredServices.map(s => `'${s}'`).join(',');
    const rows = await sfQuery(
      `SELECT "name" AS NAME, "status" AS STATUS, "current_instances"::INT AS CUR, "target_instances"::INT AS TGT
       FROM TABLE(RESULT_SCAN(LAST_QUERY_ID()))
       WHERE "name" IN (${filterList})`,
      'OPENROUTESERVICE_APP', 'CORE'
    );
    return rows.map((r: any) => ({ name: r.NAME, status: r.STATUS, cur: Number(r.CUR) || 0, tgt: Number(r.TGT) || 0 }));
  }, [requiredServices]);

  useEffect(() => {
    let active = true;
    const tick = async () => { try { const s = await fetchSvcStatus(); if (active) setSvcStatus(s); } catch {} };
    tick();
    const id = setInterval(tick, 30000);
    return () => { active = false; clearInterval(id); };
  }, [fetchSvcStatus]);

  const allReady = svcStatus.length > 0 && svcStatus.every(s => s.status === 'RUNNING' && s.cur >= s.tgt);
  const readyCount = svcStatus.filter(s => s.status === 'RUNNING' && s.cur >= s.tgt).length;
  const anySuspended = svcStatus.some(s => s.status === 'SUSPENDED');

  const wakeUp = useCallback(async () => {
    setWakingUp(true);
    try {
      const initial = await fetchSvcStatus();
      setSvcStatus(initial);
      const suspended = initial.filter(s => s.status === 'SUSPENDED').map(s => s.name);
      if (suspended.length) {
        await Promise.all(suspended.map(n =>
          sfQuery(`ALTER SERVICE OPENROUTESERVICE_APP.CORE.${n} RESUME`, 'OPENROUTESERVICE_APP', 'CORE')
        ));
      }
      for (let i = 0; i < 18; i++) {
        await new Promise(r => setTimeout(r, 5000));
        const next = await fetchSvcStatus();
        setSvcStatus(next);
        if (next.every(r => r.status === 'RUNNING' && r.cur >= r.tgt)) break;
      }
    } finally {
      setWakingUp(false);
    }
  }, [fetchSvcStatus]);

  const [viewState, setViewState] = useState({ longitude: center.lng, latitude: center.lat, zoom, pitch: 0, bearing: 0 });
  const [mapDims, setMapDims] = useState<{ width: number; height: number } | null>(null);
  const mapContainerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = mapContainerRef.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      const { width, height } = entries[0].contentRect;
      if (width > 0 && height > 0) setMapDims({ width: Math.round(width), height: Math.round(height) });
    });
    ro.observe(el);
    if (el.clientWidth > 0 && el.clientHeight > 0) setMapDims({ width: el.clientWidth, height: el.clientHeight });
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    setViewState(prev => ({ ...prev, longitude: center.lng, latitude: center.lat, zoom }));
  }, [center.lng, center.lat, zoom]);

  useEffect(() => {
    (async () => {
      if (USE_MOCK) {
        setTrailers(MOCK_TRAILERS);
        setInternal(buildMockInternal());
        setExternal(buildMockExternal());
        setSeedHint('Mock data mode (USE_MOCK=true). Run seed-data.sql and flip the toggle to read live tables.');
        return;
      }
      const [tRows, iRows, eRows, cRows] = await Promise.all([
        sfQuery(`SELECT * FROM ${BM_DB}.${BM_SCHEMA}.VW_TRAILERS LIMIT 100`),
        sfQuery(`SELECT ID, PICKUP_CITY, PICKUP_LON, PICKUP_LAT, DROPOFF_CITY, DROPOFF_LON, DROPOFF_LAT, PICKUP_FROM_TS, PICKUP_TO_TS, WEIGHT_KG, PRODUCT, HAZMAT FROM ${BM_DB}.${BM_SCHEMA}.VW_INTERNAL_VOLUMES LIMIT 200`),
        sfQuery(`SELECT OFFER_ID, SOURCE, PICKUP_CITY, PICKUP_COUNTRY, PICKUP_LON, PICKUP_LAT, DROPOFF_CITY, DROPOFF_COUNTRY, DROPOFF_LON, DROPOFF_LAT, PICKUP_FROM_TS, PICKUP_TO_TS, WEIGHT_KG, PRODUCT, PRICE_EUR, HAZMAT, LISTING_TEXT FROM ${BM_DB}.${BM_SCHEMA}.VW_EXTERNAL_OFFERS LIMIT 500`),
        sfQuery(`SELECT KEY, VALUE FROM ${BM_DB}.${BM_SCHEMA}.CONFIG`),
      ]);
      setTrailers(tRows as Trailer[]);
      setInternal(iRows as Volume[]);
      setExternal(eRows as Offer[]);
      const cfg: Record<string, any> = {};
      for (const r of cRows) cfg[(r as any).KEY] = (r as any).VALUE;
      if (cfg.INTERNAL_PRIORITY != null) setInternalPriority(Number(cfg.INTERNAL_PRIORITY));
      if (cfg.EXTERNAL_PRIORITY != null) setExternalPriority(Number(cfg.EXTERNAL_PRIORITY));
      if (cfg.TIME_WINDOW_TOLERANCE_HRS != null) setWindowToleranceHrs(Number(cfg.TIME_WINDOW_TOLERANCE_HRS));
      if (cfg.MAX_EMPTY_KM != null) setMaxEmptyKm(Number(cfg.MAX_EMPTY_KM));
      if (!tRows.length || !iRows.length || !eRows.length) {
        setSeedHint('Tables are empty. Run .cortex/skills/backload-matching/references/load-demo-data.sql, then refresh.');
      }
    })();
  }, []);

  const solve = useCallback(async () => {
    if (!trailers.length) return;
    setSolving(true); setAssignments([]); setUnassigned([]); setRationale({}); setConfirmMsg(null); setSolverLog(null);

    // Auto-warm: if any required ORS service is suspended/warming, resume + wait before issuing OPTIMIZATION.
    const probe = await fetchSvcStatus();
    setSvcStatus(probe);
    if (!probe.every(s => s.status === 'RUNNING' && s.cur >= s.tgt)) {
      setSolverLog('Routing services are suspended/warming. Resuming before solve...');
      await wakeUp();
    }

    const trailerById = new Map<number, Trailer>();
    const vrpVehicles = trailers.slice(0, 30).map((t, i) => {
      const id = i + 1;
      trailerById.set(id, t);
      return {
        id,
        profile: 'driving-hgv',
        start: [Number(t.DROPOFF_LON), Number(t.DROPOFF_LAT)],
        end:   [Number(t.HOME_LON),    Number(t.HOME_LAT)],
        capacity: [Number(t.MAX_PAYLOAD_KG) || 24000],
        skills: t.HAZMAT_CERT ? [1, 2, 3] : [1, 2],
      };
    });

    const offerById = new Map<number, { kind: 'INTERNAL' | string; row: any }>();
    let nextId = 1000;
    const vrpJobs: any[] = [];

    for (const v of internal) {
      const id = nextId++;
      offerById.set(id, { kind: 'INTERNAL', row: v });
      vrpJobs.push({
        id,
        location: [Number(v.PICKUP_LON), Number(v.PICKUP_LAT)],
        service: 1800,
        amount: [Math.min(Number(v.WEIGHT_KG), 24000)],
        skills: v.HAZMAT ? [1, 3] : [1],
        priority: internalPriority,
      });
    }
    for (const o of external) {
      const id = nextId++;
      offerById.set(id, { kind: o.SOURCE, row: o });
      vrpJobs.push({
        id,
        location: [Number(o.PICKUP_LON), Number(o.PICKUP_LAT)],
        service: 1800,
        amount: [Math.min(Number(o.WEIGHT_KG), 24000)],
        skills: o.HAZMAT ? [2, 3] : [2],
        priority: externalPriority,
      });
    }

    const challenge = { vehicles: vrpVehicles, jobs: vrpJobs, options: { g: true } };
    const jsonStr = JSON.stringify(challenge).replace(/'/g, "''");
    const sql = `SELECT * FROM TABLE(OPENROUTESERVICE_APP.CORE.OPTIMIZATION(PARSE_JSON('${jsonStr}'), '${regionName}'))`;
    console.log('[BM] OPTIMIZATION challenge: vehicles=', vrpVehicles.length, 'jobs=', vrpJobs.length, 'region=', regionName);
    const rows = await sfQuery(sql, 'OPENROUTESERVICE_APP', 'CORE');

    const newAssignments: Assignment[] = [];
    const newUnassigned: { id: number; reason?: string }[] = [];
    for (const r of rows) {
      const vehId = Number(r.VEHICLE);
      if (!vehId) {
        try {
          const ua = typeof r.UNASSIGNED === 'string' ? JSON.parse(r.UNASSIGNED) : r.UNASSIGNED;
          if (Array.isArray(ua)) for (const u of ua) newUnassigned.push({ id: Number(u.id), reason: u.reason });
        } catch {}
        continue;
      }
      const t = trailerById.get(vehId);
      if (!t) continue;
      let steps: any[] = [];
      try { steps = typeof r.STEPS === 'string' ? JSON.parse(r.STEPS) : (r.STEPS || []); } catch {}
      let routeGeo: any = null;
      try { routeGeo = typeof r.GEOJSON === 'string' ? JSON.parse(r.GEOJSON) : r.GEOJSON; } catch {}
      const jobSteps = steps.filter((s: any) => s.type === 'job');
      if (!jobSteps.length) continue;
      const first = jobSteps[0];
      const ent = offerById.get(Number(first.job));
      if (!ent) continue;
      const row: any = ent.row;
      const empty = haversineKm(t.DROPOFF_LON, t.DROPOFF_LAT, row.PICKUP_LON, row.PICKUP_LAT);
      if (empty > maxEmptyKm) continue;
      const loaded = haversineKm(row.PICKUP_LON, row.PICKUP_LAT, row.DROPOFF_LON, row.DROPOFF_LAT);
      newAssignments.push({
        TRAILER_ID: t.TRAILER_ID,
        OFFER_ID: ent.kind === 'INTERNAL' ? row.ID : row.OFFER_ID,
        SOURCE: ent.kind,
        PICKUP_LON: row.PICKUP_LON, PICKUP_LAT: row.PICKUP_LAT,
        DROPOFF_LON: row.DROPOFF_LON, DROPOFF_LAT: row.DROPOFF_LAT,
        TRAILER_DROPOFF_LON: t.DROPOFF_LON, TRAILER_DROPOFF_LAT: t.DROPOFF_LAT,
        HOME_LON: t.HOME_LON, HOME_LAT: t.HOME_LAT,
        EMPTY_KM: empty, LOADED_KM: loaded,
        SCORE: Number(r.COST) || 0,
        PRODUCT: row.PRODUCT,
        PICKUP_CITY: row.PICKUP_CITY,
        PROPOSAL_DROPOFF_CITY: row.DROPOFF_CITY,
        ROUTE_GEOJSON: routeGeo,
      });
    }
    setAssignments(newAssignments);
    setUnassigned(newUnassigned);
    setSolverLog(`Sent ${vrpVehicles.length} vehicles, ${vrpJobs.length} jobs (region=${regionName}). Received ${rows.length} rows, ${newAssignments.length} assignments, ${newUnassigned.length} unassigned.`);

    Promise.all(newAssignments.map(async (a) => {
      const key = `${a.TRAILER_ID}|${a.OFFER_ID}`;
      const cached = emptyLegCacheRef.current.get(key);
      if (cached) { a.EMPTY_GEOJSON = cached; return; }
      const dirSql = `SELECT ST_ASGEOJSON(GEOJSON)::VARCHAR AS GEOJSON FROM TABLE(OPENROUTESERVICE_APP.CORE.DIRECTIONS('driving-hgv', ARRAY_CONSTRUCT(${a.TRAILER_DROPOFF_LON}::FLOAT, ${a.TRAILER_DROPOFF_LAT}::FLOAT), ARRAY_CONSTRUCT(${a.PICKUP_LON}::FLOAT, ${a.PICKUP_LAT}::FLOAT), '${regionName}'))`;
      const dirRows = await sfQuery(dirSql, 'OPENROUTESERVICE_APP', 'CORE');
      try {
        const geo = dirRows[0]?.GEOJSON ? (typeof dirRows[0].GEOJSON === 'string' ? JSON.parse(dirRows[0].GEOJSON) : dirRows[0].GEOJSON) : null;
        if (geo) { emptyLegCacheRef.current.set(key, geo); a.EMPTY_GEOJSON = geo; }
      } catch (e) { console.warn('[BM] empty-leg DIRECTIONS parse failed', e); }
    })).then(() => setAssignments([...newAssignments]));

    setSolving(false);
  }, [trailers, internal, external, internalPriority, externalPriority, windowToleranceHrs, maxEmptyKm, regionName, fetchSvcStatus, wakeUp]);

  const askRationale = useCallback(async (a: Assignment) => {
    setRationaleLoading(true);
    const prompt = `You are a fleet dispatcher coach. In two short sentences, explain why trailer ${a.TRAILER_ID} (idle in ${trailers.find(t=>t.TRAILER_ID===a.TRAILER_ID)?.DROPOFF_CITY || ''}) is a good match for ${a.SOURCE} offer ${a.OFFER_ID} (${a.PICKUP_CITY} -> ${a.PROPOSAL_DROPOFF_CITY}, ${Math.round(a.EMPTY_KM)} km empty, ${a.PRODUCT}). Mention empty km saved and direction-to-home if relevant.`;
    const sql = `SELECT SNOWFLAKE.CORTEX.COMPLETE('claude-sonnet-4-5', '${prompt.replace(/'/g, "''")}') AS RESULT`;
    const rows = await sfQuery(sql, 'SNOWFLAKE', 'CORTEX');
    const text = (rows[0]?.RESULT || '').toString().trim();
    setRationale(prev => ({ ...prev, [a.TRAILER_ID]: text || '(no rationale returned)' }));
    setRationaleLoading(false);
  }, [trailers]);

  const confirmPlan = useCallback(async () => {
    if (!assignments.length) return;
    setConfirming(true); setConfirmMsg(null);
    await sfQuery(`CREATE SCHEMA IF NOT EXISTS ${BM_DB}.${BM_SCHEMA}`);
    await sfQuery(`CREATE TABLE IF NOT EXISTS ${BM_DB}.${BM_SCHEMA}.PROPOSAL_DECISIONS (
      DECISION_ID  VARCHAR DEFAULT UUID_STRING() PRIMARY KEY,
      TRAILER_ID   VARCHAR,
      OFFER_ID     VARCHAR,
      SOURCE       VARCHAR,
      SCORE        FLOAT,
      EMPTY_KM     FLOAT,
      DECIDED_BY   VARCHAR,
      DECIDED_AT   TIMESTAMP_NTZ DEFAULT CURRENT_TIMESTAMP(),
      RATIONALE    VARCHAR
    ) COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-backload-matching","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"app"}}'`);
    const values = assignments.map(a => {
      const r = (rationale[a.TRAILER_ID] || '').replace(/'/g, "''").slice(0, 500);
      return `('${a.TRAILER_ID}', '${a.OFFER_ID}', '${a.SOURCE}', ${a.SCORE.toFixed(2)}, ${a.EMPTY_KM.toFixed(2)}, 'demo-user', '${r}')`;
    }).join(',\n');
    const insertSql = `INSERT INTO ${BM_DB}.${BM_SCHEMA}.PROPOSAL_DECISIONS (TRAILER_ID, OFFER_ID, SOURCE, SCORE, EMPTY_KM, DECIDED_BY, RATIONALE) VALUES\n${values}`;
    await sfQuery(insertSql);
    setConfirmMsg(`Wrote ${assignments.length} decisions to ${BM_DB}.${BM_SCHEMA}.PROPOSAL_DECISIONS.`);
    setConfirming(false);
  }, [assignments, rationale]);

  const [auditRows, setAuditRows] = useState<any[]>([]);
  const loadAudit = useCallback(async () => {
    const sql = `SELECT TO_VARCHAR(DECIDED_AT, 'YYYY-MM-DD HH24:MI') AS DECIDED_AT, TRAILER_ID, OFFER_ID, SOURCE, ROUND(EMPTY_KM,1) AS EMPTY_KM, ROUND(EMPTY_KM * (SELECT VALUE::FLOAT FROM ${BM_DB}.${BM_SCHEMA}.CONFIG WHERE KEY='EUR_PER_EMPTY_KM'), 0) AS EUR_RECLAIMED FROM ${BM_DB}.${BM_SCHEMA}.PROPOSAL_DECISIONS ORDER BY DECIDED_AT DESC LIMIT 25`;
    const rows = await sfQuery(sql);
    setAuditRows(rows);
  }, []);
  useEffect(() => { loadAudit(); }, [loadAudit, confirmMsg]);

  const totalEmptyKm = useMemo(() => assignments.reduce((s, a) => s + a.EMPTY_KM, 0), [assignments]);
  const totalLoadedKm = useMemo(() => assignments.reduce((s, a) => s + a.LOADED_KM, 0), [assignments]);
  const internalCount = useMemo(() => assignments.filter(a => a.SOURCE === 'INTERNAL').length, [assignments]);
  const internalPct = assignments.length ? Math.round((internalCount / assignments.length) * 100) : 0;
  const trailersAssignedPct = trailers.length ? Math.round((assignments.length / Math.min(trailers.length, 30)) * 100) : 0;
  const eurReclaimed = Math.round(totalLoadedKm * 1.20);

  const basemap = useMemo(() => cartoBasemap(), []);
  const layers = useMemo(() => {
    const result: any[] = [basemap];
    if (external.length) {
      result.push(new ScatterplotLayer({
        id: 'ext-offers', data: external, getPosition: (d: Offer) => [Number(d.PICKUP_LON), Number(d.PICKUP_LAT)],
        getFillColor: [200, 200, 200, 120], getLineColor: [120, 120, 120, 200],
        stroked: true, lineWidthMinPixels: 1, getRadius: 1500, radiusMinPixels: 4, pickable: true,
      }));
    }
    if (internal.length) {
      result.push(new ScatterplotLayer({
        id: 'int-vols', data: internal, getPosition: (d: Volume) => [Number(d.PICKUP_LON), Number(d.PICKUP_LAT)],
        getFillColor: [41, 181, 232, 200], getRadius: 1800, radiusMinPixels: 5, pickable: true,
      }));
    }
    if (trailers.length) {
      result.push(new ScatterplotLayer({
        id: 'trailers', data: trailers, getPosition: (d: Trailer) => [Number(d.DROPOFF_LON), Number(d.DROPOFF_LAT)],
        getFillColor: [13, 176, 72, 230], getLineColor: [255, 255, 255, 255],
        stroked: true, lineWidthMinPixels: 2, getRadius: 3000, radiusMinPixels: 7, pickable: true,
      }));
    }
    assignments.forEach((a, i) => {
      const c = ROUTE_COLORS[i % ROUTE_COLORS.length];
      if (a.ROUTE_GEOJSON) {
        result.push(new GeoJsonLayer({
          id: `loaded-${i}`, data: a.ROUTE_GEOJSON, stroked: true, filled: false,
          getLineColor: [...c, 230], lineWidthMinPixels: 3,
        }));
      } else {
        result.push(new GeoJsonLayer({
          id: `loaded-${i}`, data: { type:'Feature', geometry:{ type:'LineString', coordinates:[[a.PICKUP_LON,a.PICKUP_LAT],[a.DROPOFF_LON,a.DROPOFF_LAT]] } } as any,
          stroked: true, getLineColor: [...c, 230], lineWidthMinPixels: 3,
        }));
      }
      result.push(new GeoJsonLayer({
        id: `empty-${i}`,
        data: (a.EMPTY_GEOJSON ? a.EMPTY_GEOJSON : { type:'Feature', geometry:{ type:'LineString', coordinates:[[a.TRAILER_DROPOFF_LON,a.TRAILER_DROPOFF_LAT],[a.PICKUP_LON,a.PICKUP_LAT]] } }) as any,
        stroked: true, getLineColor: [128, 128, 128, 180], getDashArray: [4, 4], lineWidthMinPixels: 2,
      }));
    });
    if (selectedTrailer) {
      const a = assignments.find(x => x.TRAILER_ID === selectedTrailer);
      if (a) {
        result.push(new IconLayer({
          id: 'selected', data: [a], getPosition: (d: Assignment) => [Number(d.PICKUP_LON), Number(d.PICKUP_LAT)],
          getColor: [245, 158, 11], getSize: 28, sizeUnits: 'pixels',
          getIcon: () => ({ url: 'data:image/svg+xml;utf8,<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 32 32"><circle cx="16" cy="16" r="12" fill="none" stroke="white" stroke-width="3"/></svg>', width: 32, height: 32 }),
        }));
      }
    }
    return result;
  }, [basemap, external, internal, trailers, assignments, selectedTrailer]);

  const getTooltip = useCallback(({ object }: any) => {
    if (!object) return null;
    if (object.TRAILER_ID) return { html: `<b>${object.TRAILER_ID}</b><br/>Idle in: ${object.DROPOFF_CITY}<br/>Home: ${object.HOME_DEPOT}<br/>HAZMAT: ${object.HAZMAT_CERT ? 'yes' : 'no'}`, style: { backgroundColor: '#14141f', color: '#e8e8f0', padding: '8px', borderRadius: '4px', fontSize: '12px' } };
    if (object.OFFER_ID) return { html: `<b>${object.SOURCE} ${object.OFFER_ID}</b><br/>${object.PICKUP_CITY} -> ${object.DROPOFF_CITY}<br/>${object.WEIGHT_KG} kg - ${object.PRODUCT}<br/>EUR ${object.PRICE_EUR}`, style: { backgroundColor: '#14141f', color: '#e8e8f0', padding: '8px', borderRadius: '4px', fontSize: '12px' } };
    if (object.ID) return { html: `<b>Internal ${object.ID}</b><br/>${object.PICKUP_CITY} -> ${object.DROPOFF_CITY}<br/>${object.WEIGHT_KG} kg - ${object.PRODUCT}`, style: { backgroundColor: '#14141f', color: '#e8e8f0', padding: '8px', borderRadius: '4px', fontSize: '12px' } };
    return null;
  }, []);

  const selected = assignments.find(a => a.TRAILER_ID === selectedTrailer);

  return (
    <div className="panel" style={{ padding: 16 }}>
      <h2 style={{ fontSize: 20, marginBottom: 4 }}>Backload Matching Engine</h2>
      <p className="subtitle">Fleet-wide VRP solve over idle-bound trailers, internal volumes, and external freight-exchange offers.</p>

      {seedHint && (
        <div className="info-box" style={{ background: 'rgba(245,158,11,0.12)', color: '#a16207', border: '1px solid rgba(245,158,11,0.4)', padding: 8, borderRadius: 6, marginBottom: 12, fontSize: 12 }}>
          {seedHint}
        </div>
      )}

      <div className="metric-grid" style={{ marginBottom: 12 }}>
        <MetricCard label="Trailers" value={trailers.length} />
        <MetricCard label="Internal volumes" value={internal.length} />
        <MetricCard label="External offers" value={external.length} />
        <MetricCard label="% trailers assigned" value={`${trailersAssignedPct}%`} />
        <MetricCard label="% internal coverage" value={`${internalPct}%`} />
        <MetricCard label="EUR/day reclaimed" value={`EUR ${eurReclaimed.toLocaleString()}`} />
      </div>

      <div style={{ display: 'flex', gap: 12, alignItems: 'flex-end', flexWrap: 'wrap', marginBottom: 12 }}>
        <div style={{ minWidth: 180 }}>
          <label className="range-label">Internal priority: {internalPriority}</label>
          <input type="range" min={1} max={200} value={internalPriority} onChange={e => setInternalPriority(Number(e.target.value))} style={{ width: '100%' }} />
        </div>
        <div style={{ minWidth: 180 }}>
          <label className="range-label">External priority: {externalPriority}</label>
          <input type="range" min={1} max={200} value={externalPriority} onChange={e => setExternalPriority(Number(e.target.value))} style={{ width: '100%' }} />
        </div>
        <div style={{ minWidth: 180 }}>
          <label className="range-label">Time-window slack: +/- {windowToleranceHrs} h</label>
          <input type="range" min={0} max={12} value={windowToleranceHrs} onChange={e => setWindowToleranceHrs(Number(e.target.value))} style={{ width: '100%' }} />
        </div>
        <div style={{ minWidth: 180 }}>
          <label className="range-label">Max empty km/leg: {maxEmptyKm}</label>
          <input type="range" min={50} max={600} step={10} value={maxEmptyKm} onChange={e => setMaxEmptyKm(Number(e.target.value))} style={{ width: '100%' }} />
        </div>
        <button className="btn-primary" onClick={solve} disabled={solving || !trailers.length} style={{ background: '#0DB048', minWidth: 140 }}>
          {solving ? 'Solving...' : 'Solve Backloads'}
        </button>
        <button className="btn-primary" onClick={wakeUp} disabled={wakingUp} title="Resume suspended ORS routing services" style={{ background: anySuspended ? '#E5484D' : '#6B7280', minWidth: 130 }}>
          {wakingUp ? 'Resuming...' : 'Wake up ORS'}
        </button>
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 11, padding: '3px 8px', borderRadius: 12, border: '1px solid var(--border)' }}
              title={svcStatus.map(s => `${s.name}: ${s.status} ${s.cur}/${s.tgt}`).join('\n')}>
          <span style={{ width: 8, height: 8, borderRadius: '50%', background: allReady ? '#10b981' : (anySuspended ? '#ef4444' : '#f59e0b') }} />
          {svcStatus.length ? `${readyCount}/${svcStatus.length} ${allReady ? 'ready' : (anySuspended ? 'suspended' : 'warming')}` : 'checking...'}
        </span>
        <button className="btn-primary" onClick={confirmPlan} disabled={confirming || !assignments.length} style={{ minWidth: 140 }}>
          {confirming ? 'Saving...' : 'Confirm Plan'}
        </button>
      </div>

      {confirmMsg && (
        <div className="info-box success" style={{ marginBottom: 12 }}>{confirmMsg}</div>
      )}
      {solverLog && (
        <div style={{ marginBottom: 12, fontSize: 11, fontFamily: 'monospace', padding: '6px 10px', background: 'rgba(0,0,0,0.04)', borderRadius: 4, color: 'var(--text-secondary)' }}>
          {solverLog}
        </div>
      )}

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 360px', gap: 12 }}>
        <div ref={mapContainerRef} style={{ height: 560, borderRadius: 8, border: '1px solid var(--border)', overflow: 'hidden', position: 'relative', background: '#e8e8e8' }}>
          {solving && (
            <div style={{ position: 'absolute', inset: 0, background: 'rgba(0,0,0,0.45)', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#fff', zIndex: 10, fontSize: 14 }}>
              Calling OPTIMIZATION...
            </div>
          )}
          {mapDims && (
            <DeckGL
              width={mapDims.width} height={mapDims.height}
              viewState={viewState}
              onViewStateChange={({ viewState: vs }: any) => setViewState(vs)}
              controller={true} layers={layers} getTooltip={getTooltip}
              style={{ position: 'absolute', top: '0', left: '0', width: `${mapDims.width}px`, height: `${mapDims.height}px` }}
            />
          )}
        </div>

        <div style={{ height: 560, overflowY: 'auto', border: '1px solid var(--border)', borderRadius: 8, padding: 8 }}>
          <h3 style={{ fontSize: 13, marginTop: 0 }}>Assignments ({assignments.length})</h3>
          {!assignments.length && <div style={{ fontSize: 12, color: 'var(--text-secondary)' }}>Click <b>Solve Backloads</b> to compute the optimal plan.</div>}
          {assignments.map((a, i) => {
            const c = ROUTE_COLORS[i % ROUTE_COLORS.length];
            const isSel = selectedTrailer === a.TRAILER_ID;
            return (
              <div key={a.TRAILER_ID} onClick={() => setSelectedTrailer(a.TRAILER_ID)}
                   style={{ padding: 8, borderRadius: 6, marginBottom: 6, cursor: 'pointer',
                            border: isSel ? '1px solid #0DB048' : '1px solid var(--border)',
                            background: isSel ? 'rgba(13,176,72,0.06)' : 'transparent' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <span style={{ width: 10, height: 10, borderRadius: 2, background: `rgb(${c.join(',')})`, flexShrink: 0 }} />
                  <b style={{ fontSize: 12 }}>{a.TRAILER_ID}</b>
                  <span style={{ fontSize: 11, padding: '1px 6px', borderRadius: 4, background: a.SOURCE === 'INTERNAL' ? 'rgba(41,181,232,0.18)' : 'rgba(200,200,200,0.4)' }}>
                    {a.SOURCE}
                  </span>
                </div>
                <div style={{ fontSize: 11, color: 'var(--text-secondary)', marginTop: 2 }}>
                  {a.PICKUP_CITY} -&gt; {a.PROPOSAL_DROPOFF_CITY}
                </div>
                <div style={{ fontSize: 11, marginTop: 2 }}>
                  empty {Math.round(a.EMPTY_KM)} km - loaded {Math.round(a.LOADED_KM)} km - {a.PRODUCT}
                </div>
                {isSel && (
                  <div style={{ marginTop: 6 }}>
                    <button onClick={(e) => { e.stopPropagation(); askRationale(a); }} disabled={rationaleLoading}
                            style={{ fontSize: 11, padding: '3px 8px', border: '1px solid var(--border)', borderRadius: 4, background: 'transparent', cursor: 'pointer' }}>
                      {rationaleLoading ? 'Asking Cortex...' : 'Why this assignment?'}
                    </button>
                    {rationale[a.TRAILER_ID] && (
                      <div style={{ marginTop: 6, padding: 6, fontSize: 11, background: 'rgba(0,0,0,0.04)', borderRadius: 4 }}>
                        {rationale[a.TRAILER_ID]}
                      </div>
                    )}
                  </div>
                )}
              </div>
            );
          })}
          {unassigned.length > 0 && (
            <div style={{ fontSize: 11, marginTop: 8, color: 'var(--text-secondary)' }}>
              {unassigned.length} jobs unassigned (capacity / time / skill mismatch).
            </div>
          )}
        </div>
      </div>

      {selected && (
        <div style={{ marginTop: 12, fontSize: 11, color: 'var(--text-secondary)' }}>
          Selected trailer: <b>{selected.TRAILER_ID}</b> - score {selected.SCORE.toFixed(0)} - empty {Math.round(selected.EMPTY_KM)} km
        </div>
      )}

      <div style={{ marginTop: 16, padding: 12, border: '1px solid var(--border)', borderRadius: 8 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
          <h3 style={{ fontSize: 14, margin: 0 }}>Decisions Audit (last 25)</h3>
          <button onClick={loadAudit} style={{ fontSize: 11, padding: '2px 8px', border: '1px solid var(--border)', borderRadius: 4, background: 'transparent', cursor: 'pointer' }}>Refresh</button>
          <span style={{ fontSize: 11, color: 'var(--text-secondary)' }}>
            Total reclaimed: EUR {auditRows.reduce((s, r) => s + Number(r.EUR_RECLAIMED || 0), 0).toLocaleString()}
          </span>
        </div>
        {!auditRows.length && <div style={{ fontSize: 12, color: 'var(--text-secondary)' }}>No decisions yet. Solve + Confirm Plan to populate.</div>}
        {auditRows.length > 0 && (
          <table style={{ width: '100%', fontSize: 11, borderCollapse: 'collapse' }}>
            <thead>
              <tr style={{ borderBottom: '1px solid var(--border)' }}>
                <th style={{ textAlign: 'left', padding: '4px 6px' }}>Decided</th>
                <th style={{ textAlign: 'left', padding: '4px 6px' }}>Trailer</th>
                <th style={{ textAlign: 'left', padding: '4px 6px' }}>Offer</th>
                <th style={{ textAlign: 'left', padding: '4px 6px' }}>Source</th>
                <th style={{ textAlign: 'right', padding: '4px 6px' }}>Empty km</th>
                <th style={{ textAlign: 'right', padding: '4px 6px' }}>EUR reclaimed</th>
              </tr>
            </thead>
            <tbody>
              {auditRows.map((r, i) => (
                <tr key={i} style={{ borderBottom: '1px solid rgba(0,0,0,0.04)' }}>
                  <td style={{ padding: '3px 6px' }}>{r.DECIDED_AT}</td>
                  <td style={{ padding: '3px 6px' }}>{r.TRAILER_ID}</td>
                  <td style={{ padding: '3px 6px' }}>{r.OFFER_ID}</td>
                  <td style={{ padding: '3px 6px' }}>{r.SOURCE}</td>
                  <td style={{ padding: '3px 6px', textAlign: 'right' }}>{r.EMPTY_KM}</td>
                  <td style={{ padding: '3px 6px', textAlign: 'right' }}>{r.EUR_RECLAIMED}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}

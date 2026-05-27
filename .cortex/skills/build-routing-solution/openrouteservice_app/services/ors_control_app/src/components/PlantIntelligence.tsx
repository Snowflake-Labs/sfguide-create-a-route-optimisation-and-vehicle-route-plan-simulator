import { useState, useCallback, useEffect, useMemo } from 'react';
import DeckGL from '@deck.gl/react';
import { ScatterplotLayer, GeoJsonLayer, TextLayer, PolygonLayer } from '@deck.gl/layers';
import { BitmapLayer } from '@deck.gl/layers';
import { TileLayer } from '@deck.gl/geo-layers';
import { AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Legend } from 'recharts';

const CARTO_LIGHT = '/api/tiles/{z}/{x}/{y}';
function cartoBasemap() {
  return new TileLayer({
    id: 'carto-pi-main', data: CARTO_LIGHT, minZoom: 0, maxZoom: 19, tileSize: 256,
    renderSubLayers: (props: any) => {
      const { boundingBox } = props.tile;
      return new BitmapLayer(props, { data: undefined, image: props.data, bounds: [boundingBox[0][0], boundingBox[0][1], boundingBox[1][0], boundingBox[1][1]] });
    }
  });
}

const SEVERITY_COLORS: [number,number,number,number][] = [[34,197,94,220],[234,179,8,220],[249,115,22,220],[239,68,68,220],[185,28,28,220]];
const SEVERITY_HEX = ['#22c55e','#eab308','#f97316','#ef4444','#b91c1c'];
const SEVERITY_LABELS = ['No Alerts','Low','Moderate','High','Critical'];
const WORLD_VIEW = { longitude: 20, latitude: 25, zoom: 1.4, pitch: 0, bearing: 0 };

function alertColor(s: string) { return s==='critical'?'#ef4444':s==='warning'?'#f97316':'#22c55e'; }
function alertRgba(s: string): [number,number,number,number] { return s==='critical'?[239,68,68,200]:s==='warning'?[249,115,22,180]:[34,197,94,160]; }
function polyCenter(polygon: [number,number][]): [number,number] {
  return [polygon.reduce((s,p)=>s+p[0],0)/polygon.length, polygon.reduce((s,p)=>s+p[1],0)/polygon.length];
}
function lerp2(a: number, b: number, t: number) { return a+(b-a)*t; }

// ─── Room contents visual generator ──────────────────────────────────────────
// Produces rack rows, equipment footprints and lab benches for the Level-4 view.
function buildRoomVisuals(zone: any, PolygonLayerClass: any, TextLayerClass: any): any[] {
  const items = zone.contents?.items || [];
  const poly = zone.polygon;
  if (!poly?.length) return [];
  const minLon = Math.min(...poly.map((p: any) => p[0])), maxLon = Math.max(...poly.map((p: any) => p[0]));
  const minLat = Math.min(...poly.map((p: any) => p[1])), maxLat = Math.max(...poly.map((p: any) => p[1]));
  const type = zone.type || 'warehouse';
  const L = (x: number) => lerp2(minLon, maxLon, x);
  const La = (y: number) => lerp2(minLat, maxLat, y);
  const R = (x0: number, x1: number, y0: number, y1: number): [number, number][] => [[L(x0),La(y0)],[L(x1),La(y0)],[L(x1),La(y1)],[L(x0),La(y1)],[L(x0),La(y0)]];

  const isRacking = ['warehouse','chill','deep_freeze','freezer','storage','quarantine','dispensary','hazardous'].includes(type);
  const isProduction = ['reactor','process','aseptic','packaging','granulation','dock'].includes(type);
  const isLab = ['lab','analytical','precision','qc','utility','hvac','electrical','control','cleanroom'].includes(type);
  const isDock = false;

  const polys: any[] = [];
  const labels: any[] = [];
  function p(polygon: [number,number][], elevation: number, color: [number,number,number,number], pickable = false, data = {}) {
    polys.push({ polygon, elevation, color, ...data });
  }
  function lbl(lon: number, lat: number, text: string, size = 8, elevation = 0.5) {
    labels.push({ position: [lon, lat, elevation], text });
  }

  // ── Aisle floor ──────────────────────────────────────────────────
  if (isRacking) {
    // dark floor tile covering whole zone
    p(R(0,1,0,1), 0.1, [30,30,30,120]);
    // bright yellow aisle strips (2 aisles)
    p(R(0,1,0.28,0.32), 0.15, [200,180,0,100]);
    p(R(0,1,0.60,0.64), 0.15, [200,180,0,100]);
  }

  // ── Rack rows (for storage zones) ───────────────────────────────
  if (isRacking) {
    const RACK_ROWS = [[0.02,0.98,0.05,0.27],[0.02,0.98,0.33,0.58],[0.02,0.98,0.65,0.90]];
    const slotsPerRow = Math.max(4, Math.ceil(items.length / 3));
    if (items.length > 0) {
      items.forEach((item: any, idx: number) => {
        const rowIdx = Math.floor(idx / slotsPerRow);
        const colIdx = idx % slotsPerRow;
        if (rowIdx >= 3) return;
        const [rx0, rx1, ry0, ry1] = RACK_ROWS[rowIdx];
        const slotW = (rx1 - rx0) / slotsPerRow;
        const gx0 = rx0 + colIdx * slotW + 0.004;
        const gx1 = rx0 + (colIdx + 1) * slotW - 0.004;
        const status = item.expiryStatus || item.status || 'ok';
        const c: [number,number,number,number] = status === 'critical' ? [239,68,68,220] : status === 'warning' ? [249,115,22,200] : [41,181,232,180];
        const elev = status === 'critical' ? 4.5 : status === 'warning' ? 3 : 2;
        p(R(gx0,gx1,ry0+0.02,ry1-0.02), elev, c, true, item);
        p(R(gx0,gx0+0.003,ry0,ry1), elev+0.5, [60,60,60,200]);
        p(R(gx1-0.003,gx1,ry0,ry1), elev+0.5, [60,60,60,200]);
        const cx = L((gx0+gx1)/2), cy = La((ry0+ry1)/2);
        lbl(cx, cy, (item.name||item.id||'').slice(0,10), 8, elev+0.6);
      });
    } else {
      RACK_ROWS.forEach(([rx0,rx1,ry0,ry1]) => p(R(rx0,rx1,ry0,ry1), 2, [41,181,232,80]));
    }
    // loading/staging area at front
    p(R(0.02,0.98,0.92,0.98), 1, [70,90,70,160]);
    lbl(L(0.5), La(0.95), 'STAGING', 9, 1.5);
    return buildLayers(polys, labels, PolygonLayerClass, TextLayerClass);
  }

  // ── Production equipment ─────────────────────────────────────────
  if (isProduction) {
    p(R(0,1,0,1), 0.1, [25,25,35,150]); // floor
    const equipLayout = [
      [0.05,0.45,0.08,0.58],
      [0.55,0.95,0.08,0.48],
      [0.55,0.95,0.55,0.92],
      [0.05,0.45,0.65,0.92],
    ];
    const renderItems = items.length > 0 ? items : [null,null,null,null];
    renderItems.slice(0, 4).forEach((item: any, idx: number) => {
      const [ex0,ex1,ey0,ey1] = equipLayout[idx] || equipLayout[0];
      const s = item ? (item.status==='Fault'?'critical':item.status==='Maintenance'||item.status==='Changeover'?'warning':'ok') : 'ok';
      const c: [number,number,number,number] = s==='critical'?[239,68,68,200]:s==='warning'?[249,115,22,180]:[107,114,128,200];
      const elev = idx===0?8:idx===1?6:idx===2?5:4;
      p(R(ex0+0.02,ex1-0.02,ey0+0.02,ey1-0.02), elev, c, true, item||{});
      p(R(ex0,ex1,ey0,ey1), 0.2, [255,255,255,20]);
      p(R(ex0+0.02,ex1-0.02,ey0+0.02,ey0+0.025), elev+0.3, [40,40,40,200]);
      p(R(ex0+0.02,ex1-0.02,ey1-0.025,ey1-0.02), elev+0.3, [40,40,40,200]);
      if (item) {
        const cx=L((ex0+ex1)/2), cy=La((ey0+ey1)/2);
        lbl(cx, cy, (item.name||item.id||'').slice(0,12), 9, elev+1);
        if (item.status) lbl(cx, cy, item.status, 7, elev+0.4);
      }
    });
    // central walkway
    p(R(0.46,0.54,0.05,0.95), 0.15, [200,180,0,80]);
    return buildLayers(polys, labels, PolygonLayerClass, TextLayerClass);
  }

  // ── Lab benches ───────────────────────────────────────────────────
  if (isLab) {
    p(R(0,1,0,1), 0.1, [20,30,40,160]); // floor
    // perimeter benches
    p(R(0.02,0.98,0.03,0.14), 1.5, [59,130,246,180]); // top bench
    p(R(0.02,0.98,0.86,0.97), 1.5, [59,130,246,180]); // bottom bench
    p(R(0.02,0.14,0.15,0.84), 1.5, [59,130,246,180]); // left bench
    p(R(0.86,0.98,0.15,0.84), 1.5, [59,130,246,180]); // right bench
    // central island
    p(R(0.30,0.70,0.30,0.70), 1.2, [41,181,232,160]);
    // instruments on benches
    const positions = [[0.15,0.35,0.04,0.13],[0.40,0.60,0.04,0.13],[0.15,0.35,0.87,0.96],[0.65,0.80,0.04,0.13]];
    const renderItems = items.length > 0 ? items : [null,null,null,null];
    renderItems.slice(0, 4).forEach((item: any, idx: number) => {
      const [ix0,ix1,iy0,iy1] = positions[idx] || positions[0];
      const c: [number,number,number,number] = item && item.status==='Maintenance' ? [249,115,22,200] : [234,179,8,200];
      p(R(ix0,ix1,iy0,iy1), 2.5, c, true, item||{});
      if (item) lbl(L((ix0+ix1)/2), La((iy0+iy1)/2), (item.name||item.id||'').slice(0,10), 7, 3);
    });
    lbl(L(0.5), La(0.5), 'WORKSPACE', 9, 1.5);
    return buildLayers(polys, labels, PolygonLayerClass, TextLayerClass);
  }

  // ── Fallback: improved grid ───────────────────────────────────────
  p(R(0,1,0,1), 0.1, [30,30,30,120]);
  if (items.length > 0) {
    const gc = Math.ceil(Math.sqrt(items.length)), gr = Math.ceil(items.length/gc);
    items.forEach((item: any, i: number) => {
      const row=Math.floor(i/gc), col=i%gc, pad=0.06;
      const x0=col/gc+pad/gc, x1=(col+1)/gc-pad/gc, y0=row/gr+pad/gr, y1=(row+1)/gr-pad/gr;
      const s = item.expiryStatus||item.status||'ok';
      const c: [number,number,number,number] = s==='critical'?[239,68,68,200]:s==='warning'?[249,115,22,180]:[41,181,232,160];
      p(R(x0,x1,y0,y1), 2, c, true, item);
      lbl(L((x0+x1)/2), La((y0+y1)/2), (item.name||item.id||'').slice(0,10), 8, 2.5);
    });
  } else {
    p(R(0.05,0.95,0.05,0.95), 1, [41,181,232,60]);
    lbl(L(0.5), La(0.5), zone.name||zone.type||'ZONE', 11, 1.5);
  }
  return buildLayers(polys, labels, PolygonLayerClass, TextLayerClass);
}

function buildLayers(polys: any[], labels: any[], PolygonLayerClass: any, TextLayerClass: any): any[] {
  return [
    new PolygonLayerClass({ id:'pi-contents', data:polys,
      getPolygon:(d:any)=>d.polygon, getElevation:(d:any)=>d.elevation,
      getFillColor:(d:any)=>d.color,
      getLineColor:[255,255,255,60] as any, lineWidthMinPixels:1,
      extruded:true, wireframe:false, filled:true, stroked:true, pickable:true,
    } as any),
    new TextLayerClass({ id:'pi-content-labels', data:labels,
      getPosition:(d:any)=>d.position,
      getText:(d:any)=>d.text,
      getSize:(d:any)=>d.size||8, getColor:[255,255,255,230] as any,
      getTextAnchor:'middle' as any, getAlignmentBaseline:'center' as any,
      fontFamily:'monospace', billboard:true,
    } as any),
  ];
}

interface PlantStatus { PLANT_ID:number; PLANT_NAME:string; PLANT_CODE:string; CITY:string; COUNTRY:string; LATITUDE:number; LONGITUDE:number; MAX_SEVERITY:number; CAPACITY_BATCHES_MONTH:number; CRITICAL_BATCHES:number; TEMP_EXCURSIONS:number; CRITICAL_STOCK_ITEMS:number; DELAYED_SHIPMENTS:number; BATCHES_IN_PROGRESS:number; }

type NavLevel = 1 | 2 | 3 | 4;

export default function PlantIntelligence() {
  const [plants, setPlants] = useState<PlantStatus[]>([]);
  const [navLevel, setNavLevel] = useState<NavLevel>(1);
  const [selectedPlant, setSelectedPlant] = useState<PlantStatus | null>(null);
  const [campus, setCampus] = useState<any[]>([]);
  const [selectedBuilding, setSelectedBuilding] = useState<any|null>(null);
  const [selectedFloor, setSelectedFloor] = useState(0);
  const [selectedRoom, setSelectedRoom] = useState<any|null>(null);
  const [sidebarTab, setSidebarTab] = useState<'overview'|'sensors'|'timeline'>('overview');
  const [loading, setLoading] = useState(false);
  const [viewState, setViewState] = useState<any>(WORLD_VIEW);

  useEffect(() => {
    fetch('/api/plant-intel/plants')
      .then(r=>r.json())
      .then((d:any) => setPlants(Array.isArray(d)?d.map((r:any)=>({ ...r, LATITUDE:Number(r.LATITUDE), LONGITUDE:Number(r.LONGITUDE), PLANT_ID:Number(r.PLANT_ID), MAX_SEVERITY:Number(r.MAX_SEVERITY??0), CAPACITY_BATCHES_MONTH:Number(r.CAPACITY_BATCHES_MONTH??0), CRITICAL_BATCHES:Number(r.CRITICAL_BATCHES??0), TEMP_EXCURSIONS:Number(r.TEMP_EXCURSIONS??0), CRITICAL_STOCK_ITEMS:Number(r.CRITICAL_STOCK_ITEMS??0), DELAYED_SHIPMENTS:Number(r.DELAYED_SHIPMENTS??0), BATCHES_IN_PROGRESS:Number(r.BATCHES_IN_PROGRESS??0), })):[]))
      .catch(console.error);
  }, []);

  const goToCampus = useCallback(async (plant: PlantStatus) => {
    setSelectedPlant(plant); setSelectedBuilding(null); setSelectedRoom(null); setSidebarTab('overview');
    setViewState({ longitude:plant.LONGITUDE, latitude:plant.LATITUDE, zoom:15, pitch:45, bearing:-15, transitionDuration:1200 });
    setLoading(true);
    try {
      const d = await fetch(`/api/plant-intel/campus?plant_id=${plant.PLANT_ID}`).then(r=>r.json());
      setCampus(Array.isArray(d.campus)?d.campus:[]); setNavLevel(2);
    } catch(e) { console.error(e); }
    setLoading(false);
  }, []);

  const goToBuilding = useCallback((bldg: any) => {
    if (!bldg.geojson) return;
    const coords: [number,number][] = [];
    const ex = (c:any) => { if(typeof c[0]==='number') coords.push(c); else c.forEach(ex); };
    try { ex(bldg.geojson.coordinates||[]); } catch {}
    if (coords.length) {
      const lon = coords.reduce((s,c)=>s+c[0],0)/coords.length;
      const lat = coords.reduce((s,c)=>s+c[1],0)/coords.length;
      setViewState({ longitude:lon, latitude:lat, zoom:18.5, pitch:55, bearing:-20, transitionDuration:1200 });
    }
    setSelectedBuilding(bldg); setSelectedFloor(0); setSelectedRoom(null); setSidebarTab('overview'); setNavLevel(3);
  }, []);

  const goToRoom = useCallback((zone: any) => {
    if (!zone.polygon?.length) return;
    const [lon, lat] = polyCenter(zone.polygon);
    setViewState({ longitude:lon, latitude:lat, zoom:20, pitch:45, bearing:-10, transitionDuration:800 });
    setSelectedRoom(zone); setNavLevel(4);
  }, []);

  const goBack = useCallback(() => {
    if (navLevel===4) { setSelectedRoom(null); setNavLevel(3); setViewState((v:any)=>({...v,pitch:55,zoom:18.5,transitionDuration:600})); }
    else if (navLevel===3) { setSelectedBuilding(null); setNavLevel(2); if(selectedPlant) setViewState({longitude:selectedPlant.LONGITUDE,latitude:selectedPlant.LATITUDE,zoom:15,pitch:45,bearing:-15,transitionDuration:800}); }
    else if (navLevel===2) { setSelectedPlant(null); setCampus([]); setNavLevel(1); setViewState({...WORLD_VIEW,transitionDuration:800}); }
  }, [navLevel, selectedPlant]);

  const currentFloorZones = useMemo(() => {
    if (!selectedBuilding) return [];
    return selectedBuilding.floors?.[selectedFloor]?.zones || [];
  }, [selectedBuilding, selectedFloor]);

  const layers: any[] = useMemo(() => [
    cartoBasemap(),
    new ScatterplotLayer<PlantStatus>({ id:'pi-plants', data:plants,
      getPosition:(d:PlantStatus)=>[d.LONGITUDE,d.LATITUDE],
      getRadius:(d:PlantStatus)=>Math.sqrt(d.CAPACITY_BATCHES_MONTH)*8000,
      radiusMinPixels:navLevel===1?20:6, radiusMaxPixels:navLevel===1?55:40,
      getFillColor:(d:PlantStatus)=>SEVERITY_COLORS[Math.min(4,d.MAX_SEVERITY)] as any,
      getLineColor:[255,255,255,220] as any, lineWidthMinPixels:2, stroked:true, pickable:true,
      onClick:({object}:any)=>object&&navLevel===1&&goToCampus(object),
    } as any),
    ...(navLevel===1?[new TextLayer<PlantStatus>({ id:'pi-labels', data:plants,
      getPosition:(d:PlantStatus)=>[d.LONGITUDE,d.LATITUDE], getPixelOffset:[0,22] as any,
      getText:(d:PlantStatus)=>d.PLANT_CODE, getSize:11, getColor:[255,255,255,255] as any,
      background:true, getBackgroundColor:((d:PlantStatus)=>{const c=SEVERITY_COLORS[Math.min(4,d.MAX_SEVERITY)];return[c[0],c[1],c[2],200];}) as any,
      backgroundPadding:[5,2,5,2], fontFamily:'monospace', getAlignmentBaseline:'top', getTextAnchor:'middle',
      pickable:true, onClick:({object}:any)=>object&&goToCampus(object),
    } as any)]:[]),
    ...(navLevel>=2&&campus.length>0?[new GeoJsonLayer({ id:'pi-campus',
      data:{type:'FeatureCollection',features:campus.map(b=>({type:'Feature',geometry:b.geojson,properties:{roleId:b.roleId,role:b.role,id:b.id,alertStatus:b.alertStatus,floorCount:b.floorCount}}))},
      filled:true, extruded:true, wireframe:true,
      getFillColor:(f:any)=>{const b=campus.find((x:any)=>x.id===f.properties?.id);if(!b)return[100,100,100,180];const base=b.color as [number,number,number,number];const isSel=selectedBuilding?.id===b.id;return isSel?[Math.min(255,base[0]+60),Math.min(255,base[1]+60),Math.min(255,base[2]+60),240]:base;},
      getLineColor:[255,255,255,120] as any, lineWidthMinPixels:2,
      getElevation:(f:any)=>{const b=campus.find((x:any)=>x.id===f.properties?.id);return b?b.floorCount*5:8;},
      pickable:true, onClick:({object}:any)=>{if(object&&navLevel===2){const b=campus.find((x:any)=>x.id===object.properties?.id);if(b)goToBuilding(b);}},
    } as any)]:[]),
    ...(navLevel===2&&campus.length>0?[new TextLayer({ id:'pi-bldg-labels', data:campus,
      getPosition:(b:any)=>{const c:[number,number][]=[];const ex=(x:any)=>{if(typeof x[0]==='number')c.push(x);else x.forEach(ex);};try{ex(b.geojson?.coordinates||[]);}catch{}return c.length?[c.reduce((s:number,p:[number,number])=>s+p[0],0)/c.length,c.reduce((s:number,p:[number,number])=>s+p[1],0)/c.length,b.floorCount*5+1]:[0,0,10];},
      getText:(b:any)=>b.roleShort, getSize:13, getColor:[255,255,255,230] as any,
      getTextAnchor:'middle' as any, getAlignmentBaseline:'center' as any,
      background:true, getBackgroundColor:(b:any)=>{const c=b.color;return[Math.floor(c[0]*.4),Math.floor(c[1]*.4),Math.floor(c[2]*.4),180];},
      backgroundPadding:[5,2,5,2], fontFamily:'monospace', fontWeight:'bold' as any, billboard:true,
    } as any)]:[]),
    ...(navLevel>=3&&currentFloorZones.length>0?[
      new PolygonLayer({ id:'pi-zones', data:currentFloorZones,
        getPolygon:(z:any)=>z.polygon, getElevation:(z:any)=>z.elevation,
        getFillColor:(z:any)=>{const isSel=selectedRoom?.id===z.id;const base=alertRgba(z.alertStatus);return isSel?[Math.min(255,base[0]+60),Math.min(255,base[1]+60),Math.min(255,base[2]+60),240]:base;},
        getLineColor:[255,255,255,100] as any, lineWidthMinPixels:1,
        extruded:true, wireframe:true, pickable:true,
        onClick:({object}:any)=>{if(object&&navLevel===3)goToRoom(object);else if(object&&navLevel===4)setSelectedRoom(object);},
      } as any),
      new TextLayer({ id:'pi-zone-labels', data:currentFloorZones,
        getPosition:(z:any)=>[...polyCenter(z.polygon),z.elevation+0.5],
        getText:(z:any)=>z.name, getSize:9, getColor:[255,255,255,210] as any,
        getTextAnchor:'middle' as any, getAlignmentBaseline:'center' as any,
        background:true, getBackgroundColor:(z:any)=>{const c=alertRgba(z.alertStatus);return[Math.floor(c[0]*.3),Math.floor(c[1]*.3),Math.floor(c[2]*.3),180];},
        backgroundPadding:[3,1,3,1], billboard:true, fontFamily:'monospace',
      } as any),
      new ScatterplotLayer({ id:'pi-sensors',
        data:currentFloorZones.flatMap((z:any)=>z.sensors?.map((s:any)=>({...s,zoneId:z.id,_center:polyCenter(z.polygon)}))||[]),
        getPosition:(s:any)=>[...(s._center||[0,0]),0.3] as any,
        getFillColor:(s:any)=>(s.status==='critical'?[239,68,68,255]:s.status==='warning'?[249,115,22,255]:[34,197,94,255]),
        getRadius:1.5, radiusMinPixels:6, radiusMaxPixels:10,
        getLineColor:[255,255,255,180] as any, lineWidthMinPixels:1.5, stroked:true, pickable:true,
      } as any),
    ]:[]),
    ...(navLevel===4&&selectedRoom?(() => buildRoomVisuals(selectedRoom, PolygonLayer, TextLayer))():[]),
  // eslint-disable-next-line react-hooks/exhaustive-deps
  ], [plants, navLevel, campus, selectedBuilding, selectedFloor, currentFloorZones, selectedRoom]);

  function Chip({ label, count, color }: { label: string; count: number; color: string }) {
    if (!count) return null;
    return <div style={{ display:'flex', alignItems:'center', gap:5, padding:'3px 9px', borderRadius:5, background:`${color}22`, border:`1px solid ${color}55`, marginBottom:3 }}>
      <span style={{ color, fontWeight:700, fontSize:16 }}>{count}</span>
      <span style={{ color:'var(--text)', fontSize:11 }}>{label}</span>
    </div>;
  }

  function StatusBadge({ label, status }: { label: string; status: string }) {
    const c = alertColor(status);
    return <span style={{ background:`${c}22`, color:c, border:`1px solid ${c}55`, borderRadius:4, padding:'2px 6px', fontSize:10, fontWeight:600 }}>{label}</span>;
  }

  const timelineKeys = useMemo(() => {
    const tl = selectedBuilding?.timeline;
    if (!tl?.length) return [];
    return Object.keys(tl[0]).filter(k=>k!=='hour');
  }, [selectedBuilding]);

  const allSensors = useMemo(() => currentFloorZones.flatMap((z:any) => z.sensors?.map((s:any)=>({...s,zoneName:z.name}))||[]), [currentFloorZones]);
  const criticalSensors = allSensors.filter((s:any)=>s.status==='critical');
  const warnSensors = allSensors.filter((s:any)=>s.status==='warning');

  return (
    <div style={{ display:'flex', height:'100%', background:'var(--bg, #0f1117)' }}>
      {/* MAP */}
      <div style={{ flex:1, position:'relative' }}>
        <DeckGL viewState={viewState} onViewStateChange={({viewState:vs}:any)=>setViewState(vs)} controller layers={layers}
          getTooltip={({object}:any) => {
            if(!object) return null;
            if(object.PLANT_NAME){const s=Math.min(4,object.MAX_SEVERITY??0);return{html:`<div style="font-size:12px;padding:5px 9px"><b>${object.PLANT_NAME}</b><br/>${object.CITY},${object.COUNTRY}<br/><span style="color:${SEVERITY_HEX[s]}">${SEVERITY_LABELS[s]}</span></div>`};}
            if(object.properties?.roleId){const b=campus.find((x:any)=>x.id===object.properties?.id);const c=alertColor(b?.alertStatus||'ok');return{html:`<div style="font-size:12px;padding:5px 9px"><b>${object.properties.role}</b><br/>${b?.floorCount} floor(s)<br/><span style="color:${c}">${b?.alertStatus?.toUpperCase()}</span><br/><i>Click to inspect</i></div>`};}
            if(object.polygon&&object.name){const c=alertColor(object.alertStatus);return{html:`<div style="font-size:12px;padding:5px 9px"><b>${object.name}</b><br/><span style="color:${c}">${object.alertStatus?.toUpperCase()}</span>${navLevel===3?'<br/><i>Click to enter room</i>':''}</div>`};}
            if(object.expiryDate){const c=alertColor(object.expiryStatus||'ok');return{html:`<div style="font-size:12px;padding:5px 9px"><b>${object.name||object.id}</b><br/>${object.product||''}<br/>Expires: ${object.expiryDate} · <span style="color:${c}">${object.daysLeft}d</span></div>`};}
            if(object.status!==undefined&&object.zoneId!==undefined){const c=alertColor(object.status);return{html:`<div style="font-size:12px;padding:5px 9px"><b>${object.name}</b><br/><span style="color:${c};font-weight:700">${object.value}${object.unit}</span>${object.alert?`<br/><span style="color:#f97316">⚠ ${object.alert}</span>`:''}</div>`};}
            return null;
          }}
        />
        {navLevel>1&&<button onClick={goBack} style={{ position:'absolute', top:12, left:12, background:'rgba(0,0,0,0.78)', color:'#fff', border:'1px solid rgba(255,255,255,0.2)', borderRadius:8, padding:'6px 14px', cursor:'pointer', fontSize:13, backdropFilter:'blur(8px)' }}>← {navLevel===4?'Room List':navLevel===3?'Campus':navLevel===2?'All Plants':''}</button>}
        {navLevel===3&&selectedBuilding&&(
          <div style={{ position:'absolute', top:12, right:12, background:'rgba(0,0,0,0.78)', borderRadius:8, padding:'8px 10px', backdropFilter:'blur(8px)' }}>
            <div style={{ fontSize:9, color:'#888', marginBottom:4, textTransform:'uppercase', letterSpacing:0.5 }}>Floor</div>
            {selectedBuilding.floors?.map((f:any,i:number)=>(
              <button key={i} onClick={()=>setSelectedFloor(i)} style={{ display:'block', width:'100%', padding:'4px 10px', marginBottom:2, borderRadius:4, border:'none', background:selectedFloor===i?'#29b5e8':'rgba(255,255,255,0.08)', color:selectedFloor===i?'#fff':'#aaa', cursor:'pointer', fontSize:10, textAlign:'left', whiteSpace:'nowrap' }}>
                {f.label}
              </button>
            ))}
          </div>
        )}
        {navLevel===2&&!loading&&<div style={{ position:'absolute', bottom:16, left:'50%', transform:'translateX(-50%)', background:'rgba(41,181,232,0.9)', color:'#fff', padding:'6px 16px', borderRadius:20, fontSize:12, fontWeight:600, pointerEvents:'none' }}>Click a building to enter</div>}
        {navLevel===3&&!loading&&<div style={{ position:'absolute', bottom:16, left:'50%', transform:'translateX(-50%)', background:'rgba(41,181,232,0.9)', color:'#fff', padding:'6px 16px', borderRadius:20, fontSize:12, fontWeight:600, pointerEvents:'none' }}>Click a room to inspect contents</div>}
        {loading&&<div style={{ position:'absolute', top:'50%', left:'50%', transform:'translate(-50%,-50%)', background:'rgba(0,0,0,0.85)', color:'#fff', padding:'14px 28px', borderRadius:10, fontSize:14 }}>Loading campus…</div>}
      </div>

      {/* SIDEBAR */}
      <div style={{ width:360, background:'var(--surface, rgba(0,0,0,0.5))', borderLeft:'1px solid rgba(255,255,255,0.08)', display:'flex', flexDirection:'column', overflowY:'auto', color:'var(--text,#fff)', fontSize:13 }}>

        {/* Level 1: plant list */}
        {navLevel===1&&(
          <>
            <div style={{ padding:'16px 20px', borderBottom:'1px solid rgba(255,255,255,0.08)' }}>
              <div style={{ fontWeight:700, fontSize:16, marginBottom:4 }}>Pharma Manufacturing Plants</div>
              <div style={{ fontSize:12, color:'#888' }}>6 global manufacturing sites — click to explore campus</div>
            </div>
            {plants.map(p=>{const s=Math.min(4,p.MAX_SEVERITY??0);return(
              <div key={p.PLANT_ID} onClick={()=>goToCampus(p)} style={{ padding:'12px 20px', borderBottom:'1px solid rgba(255,255,255,0.06)', cursor:'pointer', display:'flex', alignItems:'center', gap:10 }}>
                <div style={{ width:10, height:10, borderRadius:'50%', background:SEVERITY_HEX[s], flexShrink:0 }} />
                <div style={{ flex:1 }}>
                  <div style={{ fontWeight:600 }}>{p.PLANT_NAME}</div>
                  <div style={{ fontSize:11, color:'#888' }}>{p.CITY}, {p.COUNTRY} · {p.PLANT_CODE}</div>
                </div>
                <span style={{ fontSize:11, color:SEVERITY_HEX[s], fontWeight:600 }}>{SEVERITY_LABELS[s]}</span>
              </div>
            );})}
          </>
        )}

        {/* Level 2: campus overview */}
        {navLevel===2&&selectedPlant&&(
          <>
            <div style={{ padding:'14px 20px', borderBottom:'1px solid rgba(255,255,255,0.08)' }}>
              <div style={{ fontWeight:700, fontSize:16 }}>{selectedPlant.PLANT_NAME} Campus</div>
              <div style={{ fontSize:11, color:'#888', marginBottom:10 }}>{selectedPlant.CITY}, {selectedPlant.COUNTRY}</div>
              <div style={{ display:'flex', gap:6, flexWrap:'wrap' }}>
                {selectedPlant.CRITICAL_BATCHES>0&&<Chip label="Critical Batches" count={selectedPlant.CRITICAL_BATCHES} color="#ef4444"/>}
                {selectedPlant.TEMP_EXCURSIONS>0&&<Chip label="Temp Excursions" count={selectedPlant.TEMP_EXCURSIONS} color="#f97316"/>}
                {selectedPlant.CRITICAL_STOCK_ITEMS>0&&<Chip label="Critical Stock" count={selectedPlant.CRITICAL_STOCK_ITEMS} color="#eab308"/>}
              </div>
            </div>
            {campus.map((b:any)=>(
              <div key={b.id} onClick={()=>goToBuilding(b)} style={{ padding:'11px 20px', borderBottom:'1px solid rgba(255,255,255,0.05)', cursor:'pointer', display:'flex', alignItems:'center', gap:12 }}>
                <div style={{ width:12, height:12, borderRadius:3, background:`rgb(${b.color[0]},${b.color[1]},${b.color[2]})`, flexShrink:0 }} />
                <div style={{ flex:1 }}>
                  <div style={{ fontWeight:600, fontSize:13 }}>{b.role}</div>
                  <div style={{ fontSize:11, color:'#888' }}>{b.floorCount} floor{b.floorCount>1?'s':''} · {Math.round(b.areaSqm).toLocaleString()} m²</div>
                </div>
                <StatusBadge label={b.alertStatus} status={b.alertStatus} />
              </div>
            ))}
          </>
        )}

        {/* Level 3: building / floor view */}
        {navLevel===3&&selectedBuilding&&(
          <>
            <div style={{ padding:'14px 20px', borderBottom:'1px solid rgba(255,255,255,0.08)' }}>
              <div style={{ display:'flex', alignItems:'center', gap:8, marginBottom:4 }}>
                <div style={{ width:12, height:12, borderRadius:3, background:`rgb(${selectedBuilding.color[0]},${selectedBuilding.color[1]},${selectedBuilding.color[2]})` }} />
                <div style={{ fontWeight:700, fontSize:15 }}>{selectedBuilding.role}</div>
              </div>
              <div style={{ fontSize:11, color:'#888', marginBottom:10 }}>{selectedBuilding.floors?.[selectedFloor]?.label} · {Math.round(selectedBuilding.areaSqm).toLocaleString()} m²</div>
              {criticalSensors.length>0&&<div style={{ color:'#ef4444', fontSize:12, marginBottom:4 }}>🔴 {criticalSensors.length} critical sensor{criticalSensors.length>1?'s':''}</div>}
              {warnSensors.length>0&&<div style={{ color:'#f97316', fontSize:12 }}>🟠 {warnSensors.length} warning{warnSensors.length>1?'s':''}</div>}
              <div style={{ display:'flex', gap:5, marginTop:10 }}>
                {(['overview','sensors','timeline'] as const).map(t=>(
                  <button key={t} onClick={()=>setSidebarTab(t)} style={{ padding:'4px 10px', borderRadius:12, border:'none', background:sidebarTab===t?'#29b5e8':'rgba(255,255,255,0.09)', color:sidebarTab===t?'#fff':'#aaa', cursor:'pointer', fontSize:11, fontWeight:sidebarTab===t?600:400 }}>
                    {t.charAt(0).toUpperCase()+t.slice(1)}
                  </button>
                ))}
              </div>
            </div>

            <div style={{ flex:1, overflowY:'auto' }}>
              {sidebarTab==='overview'&&currentFloorZones.map((z:any)=>(
                <div key={z.id} onClick={()=>goToRoom(z)} style={{ padding:'10px 20px', borderBottom:'1px solid rgba(255,255,255,0.05)', cursor:'pointer', display:'flex', alignItems:'center', gap:10 }}>
                  <div style={{ width:10, height:10, borderRadius:2, background:alertColor(z.alertStatus), flexShrink:0 }} />
                  <div style={{ flex:1 }}>
                    <div style={{ fontWeight:600, fontSize:12 }}>{z.name}</div>
                    <div style={{ fontSize:11, color:'#888', marginTop:2 }}>{z.sensors?.length||0} sensors · {z.contents?.items?.length||0} items</div>
                  </div>
                  <StatusBadge label={z.alertStatus} status={z.alertStatus} />
                </div>
              ))}

              {sidebarTab==='sensors'&&(
                <div style={{ padding:'4px 0' }}>
                  {allSensors.map((s:any,i:number)=>(
                    <div key={i} style={{ padding:'8px 20px', borderBottom:'1px solid rgba(255,255,255,0.04)', display:'flex', alignItems:'center', gap:9 }}>
                      <div style={{ width:8, height:8, borderRadius:'50%', background:alertColor(s.status), flexShrink:0 }} />
                      <div style={{ flex:1 }}>
                        <div style={{ fontSize:11, fontWeight:600 }}>{s.name}</div>
                        <div style={{ fontSize:10, color:'#666' }}>{s.zoneName}</div>
                        {s.alert&&<div style={{ fontSize:10, color:'#f97316', marginTop:1 }}>⚠ {s.alert}</div>}
                      </div>
                      <div style={{ fontWeight:700, fontSize:13, color:alertColor(s.status) }}>{s.value}{s.unit}</div>
                    </div>
                  ))}
                </div>
              )}

              {sidebarTab==='timeline'&&selectedBuilding.timeline&&(
                <div style={{ padding:14 }}>
                  <div style={{ fontSize:12, fontWeight:600, marginBottom:10 }}>24-Hour Readings — {selectedBuilding.role}</div>
                  <ResponsiveContainer width="100%" height={200}>
                    <AreaChart data={selectedBuilding.timeline} margin={{top:4,right:4,left:-20,bottom:0}}>
                      <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.06)"/>
                      <XAxis dataKey="hour" tick={{fontSize:8,fill:'#666'}} interval={5}/>
                      <YAxis tick={{fontSize:8,fill:'#666'}}/>
                      <Tooltip contentStyle={{background:'#1a1a2e',border:'1px solid #333',fontSize:10}}/>
                      <Legend wrapperStyle={{fontSize:9}}/>
                      {timelineKeys.slice(0,4).map((k,i)=>(
                        <Area key={k} type="monotone" dataKey={k} stroke={['#3b82f6','#06b6d4','#8b5cf6','#22c55e'][i%4]} fill={['#3b82f620','#06b6d420','#8b5cf620','#22c55e20'][i%4]} strokeWidth={2} dot={false}/>
                      ))}
                    </AreaChart>
                  </ResponsiveContainer>
                </div>
              )}
            </div>
          </>
        )}

        {/* Level 4: room contents */}
        {navLevel===4&&selectedRoom&&(
          <>
            <div style={{ padding:'14px 20px', borderBottom:'1px solid rgba(255,255,255,0.08)' }}>
              <div style={{ fontWeight:700, fontSize:15, marginBottom:4 }}>{selectedRoom.name}</div>
              <div style={{ display:'flex', gap:6, alignItems:'center', flexWrap:'wrap', marginBottom:8 }}>
                <StatusBadge label={selectedRoom.alertStatus} status={selectedRoom.alertStatus}/>
                <span style={{ fontSize:11, color:'#888' }}>{selectedRoom.contents?.items?.length||0} items · {selectedRoom.sensors?.length||0} sensors</span>
              </div>
              {selectedRoom.sensors?.filter((s:any)=>s.status!=='ok').map((s:any,i:number)=>(
                <div key={i} style={{ padding:'4px 8px', marginBottom:3, borderRadius:5, background:`${alertColor(s.status)}22`, fontSize:11 }}>
                  <span style={{ color:alertColor(s.status), fontWeight:700 }}>{s.value}{s.unit}</span> — {s.name}{s.alert?` (${s.alert})`:''}
                </div>
              ))}
            </div>
            <div style={{ flex:1, overflowY:'auto' }}>
              {(selectedRoom.contents?.items||[]).map((item:any,i:number)=>(
                <div key={i} style={{ padding:'10px 20px', borderBottom:'1px solid rgba(255,255,255,0.05)' }}>
                  <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', marginBottom:4 }}>
                    <span style={{ fontWeight:600, fontSize:12 }}>{item.name||item.id}</span>
                    {item.expiryStatus&&<StatusBadge label={item.expiryStatus} status={item.expiryStatus}/>}
                    {item.status&&!item.expiryDate&&<StatusBadge label={item.status} status={item.status==='Running'?'ok':item.status==='Fault'?'critical':'warning'}/>}
                  </div>
                  {item.product&&<div style={{ fontSize:11, color:'#aaa' }}>{item.product}</div>}
                  {item.batchNo&&<div style={{ fontSize:11, color:'#888' }}>Batch: {item.batchNo}</div>}
                  {item.expiryDate&&<div style={{ fontSize:11, color:'#888' }}>Expires: {item.expiryDate} · <span style={{ color:alertColor(item.expiryStatus||'ok') }}>{item.daysLeft}d remaining</span></div>}
                  {item.stockKg&&<div style={{ fontSize:11, color:'#888' }}>Stock: {item.stockKg} · {item.pallets}</div>}
                  {item.temperature&&<div style={{ fontSize:11, color:'#888' }}>Temp: {item.temperature}</div>}
                  {item.speed&&<div style={{ fontSize:11, color:'#aaa' }}>{item.speed}{item.compression?` · ${item.compression}`:''}</div>}
                  {item.capacity&&<div style={{ fontSize:11, color:'#aaa' }}>Capacity: {item.capacity}{item.batch?` · Batch: ${item.batch}`:''}</div>}
                </div>
              ))}
              <div style={{ padding:'10px 20px', borderTop:'1px solid rgba(255,255,255,0.08)', marginTop:4 }}>
                <div style={{ fontSize:11, fontWeight:600, color:'#888', marginBottom:8, textTransform:'uppercase', letterSpacing:0.5 }}>Sensors in this room</div>
                {(selectedRoom.sensors||[]).map((s:any,i:number)=>(
                  <div key={i} style={{ display:'flex', justifyContent:'space-between', alignItems:'center', padding:'5px 0', borderBottom:'1px solid rgba(255,255,255,0.04)' }}>
                    <div>
                      <div style={{ fontSize:11, fontWeight:600 }}>{s.name}</div>
                      {s.alert&&<div style={{ fontSize:10, color:'#f97316' }}>⚠ {s.alert}</div>}
                    </div>
                    <div style={{ fontWeight:700, color:alertColor(s.status), fontSize:13 }}>{s.value}{s.unit}</div>
                  </div>
                ))}
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

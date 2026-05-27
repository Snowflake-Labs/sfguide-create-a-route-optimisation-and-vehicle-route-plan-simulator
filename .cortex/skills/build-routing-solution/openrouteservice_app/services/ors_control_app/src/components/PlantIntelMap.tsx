import { useState, useCallback, useEffect, useMemo, useRef } from 'react';
import DeckGL from '@deck.gl/react';
import { ScatterplotLayer, GeoJsonLayer, TextLayer, PolygonLayer } from '@deck.gl/layers';
import { BitmapLayer } from '@deck.gl/layers';
import { TileLayer } from '@deck.gl/geo-layers';

const CARTO_LIGHT = '/api/tiles/{z}/{x}/{y}';
function cartoBasemap(id = 'carto-pi') {
  return new TileLayer({
    id, data: CARTO_LIGHT, minZoom: 0, maxZoom: 19, tileSize: 256,
    renderSubLayers: (props: any) => {
      const { boundingBox } = props.tile;
      return new BitmapLayer(props, { data: undefined, image: props.data, bounds: [boundingBox[0][0], boundingBox[0][1], boundingBox[1][0], boundingBox[1][1]] });
    }
  });
}

const SEVERITY_COLORS: [number,number,number,number][] = [
  [34,197,94,220],[234,179,8,220],[249,115,22,220],[239,68,68,220],[185,28,28,220],
];
const SEVERITY_HEX = ['#22c55e','#eab308','#f97316','#ef4444','#b91c1c'];
const SEVERITY_LABELS = ['OK','Low','Moderate','High','Critical'];
const WORLD_VIEW = { longitude: 20, latitude: 25, zoom: 1.4, pitch: 0, bearing: 0 };

interface PlantRow { PLANT_ID:number; PLANT_NAME:string; PLANT_CODE:string; CITY:string; COUNTRY:string; LATITUDE:number; LONGITUDE:number; MAX_SEVERITY:number; CAPACITY_BATCHES_MONTH:number; }

// Nav level: 1=world, 2=campus, 3=building+floor, 4=room
type NavLevel = 1 | 2 | 3 | 4;

function alertColor(s: string) { return s==='critical'?'#ef4444':s==='warning'?'#f97316':'#22c55e'; }
function alertRgba(s: string): [number,number,number,number] { return s==='critical'?[239,68,68,200]:s==='warning'?[249,115,22,180]:[34,197,94,160]; }

function polyCenter(polygon: [number,number][]): [number,number] {
  const lon = polygon.reduce((s,p)=>s+p[0],0)/polygon.length;
  const lat = polygon.reduce((s,p)=>s+p[1],0)/polygon.length;
  return [lon,lat];
}

interface PlantIntelMapProps {
  onBuildingSelect?: (building: any, plant: any) => void;
  onRoomSelect?: (room: any, building: any, plant: any) => void;
}

export default function PlantIntelMap({ onBuildingSelect, onRoomSelect }: PlantIntelMapProps = {}) {
  const [plants, setPlants] = useState<PlantRow[]>([]);
  const [navLevel, setNavLevel] = useState<NavLevel>(1);
  const [selectedPlant, setSelectedPlant] = useState<PlantRow | null>(null);
  const [campus, setCampus] = useState<any[]>([]);
  const [selectedBuilding, setSelectedBuilding] = useState<any | null>(null);
  const [selectedFloor, setSelectedFloor] = useState(0);
  const [selectedRoom, setSelectedRoom] = useState<any | null>(null);
  const [loading, setLoading] = useState(false);
  const [viewState, setViewState] = useState<any>(WORLD_VIEW);

  const robotsRef = useRef<any[]>([]);
  const robotRngRef = useRef<() => number>(() => 0);
  const [robotPositions, setRobotPositions] = useState<any[]>([]);

  useEffect(() => {
    fetch('/api/plant-intel/plants')
      .then(r=>r.json())
      .then((d:any) => setPlants(Array.isArray(d)?d.map((r:any)=>({...r, LATITUDE:Number(r.LATITUDE), LONGITUDE:Number(r.LONGITUDE), PLANT_ID:Number(r.PLANT_ID), MAX_SEVERITY:Number(r.MAX_SEVERITY??0), CAPACITY_BATCHES_MONTH:Number(r.CAPACITY_BATCHES_MONTH??0)})):[]))
      .catch(console.error);
  }, []);

  // Level 1 → 2: select plant, load campus
  const goToCampus = useCallback(async (plant: PlantRow) => {
    setSelectedPlant(plant); setSelectedBuilding(null); setSelectedRoom(null);
    setViewState({ longitude: plant.LONGITUDE, latitude: plant.LATITUDE, zoom: 15, pitch: 45, bearing: -15, transitionDuration: 1200 });
    setLoading(true);
    try {
      const d = await fetch(`/api/plant-intel/campus?plant_id=${plant.PLANT_ID}`).then(r=>r.json());
      setCampus(Array.isArray(d.campus) ? d.campus : []);
      setNavLevel(2);
    } catch(e) { console.error(e); }
    setLoading(false);
  }, []);

  // Level 2 → 3: select building
  const goToBuilding = useCallback((bldg: any) => {
    if (!bldg.geojson) return;
    const coords: [number,number][] = [];
    const ex = (c:any) => { if(typeof c[0]==='number') coords.push(c); else c.forEach(ex); };
    try { ex(bldg.geojson.coordinates||[]); } catch {}
    if (coords.length) {
      const lon = coords.reduce((s,c)=>s+c[0],0)/coords.length;
      const lat = coords.reduce((s,c)=>s+c[1],0)/coords.length;
      setViewState({ longitude: lon, latitude: lat, zoom: 18.5, pitch: 55, bearing: -20, transitionDuration: 1200 });
    }
    setSelectedBuilding(bldg); setSelectedFloor(0); setSelectedRoom(null); setNavLevel(3);
    onBuildingSelect?.(bldg, selectedPlant);
  }, [selectedPlant, onBuildingSelect]);

  // Level 3 → 4: drill into room
  const goToRoom = useCallback((zone: any) => {
    if (!zone.polygon?.length) return;
    const [lon, lat] = polyCenter(zone.polygon);
    setViewState({ longitude: lon, latitude: lat, zoom: 20, pitch: 45, bearing: -10, transitionDuration: 800 });
    setSelectedRoom(zone); setNavLevel(4);
    onRoomSelect?.(zone, selectedBuilding, selectedPlant);
  }, [selectedBuilding, selectedPlant, onRoomSelect]);

  const goBack = useCallback(() => {
    if (navLevel === 4) { setSelectedRoom(null); setNavLevel(3); setViewState((v:any)=>({...v, pitch:55, zoom:18.5, transitionDuration:600})); }
    else if (navLevel === 3) { setSelectedBuilding(null); setNavLevel(2); if(selectedPlant) setViewState({ longitude:selectedPlant.LONGITUDE, latitude:selectedPlant.LATITUDE, zoom:15, pitch:45, bearing:-15, transitionDuration:800 }); }
    else if (navLevel === 2) { setSelectedPlant(null); setCampus([]); setNavLevel(1); setViewState({...WORLD_VIEW, transitionDuration:800}); }
  }, [navLevel, selectedPlant]);

  const currentFloorZones = useMemo(() => {
    if (!selectedBuilding) return [];
    const f = selectedBuilding.floors?.[selectedFloor];
    return f?.zones || [];
  }, [selectedBuilding, selectedFloor]);

  useEffect(() => {
    if (navLevel >= 3 && currentFloorZones.length > 0 && selectedPlant && selectedBuilding) {
      const seed = selectedPlant.PLANT_ID * 37 + (selectedBuilding.id?.charCodeAt(0) || 1) * 13 + selectedFloor * 7;
      robotRngRef.current = rng2(seed + 1000);
      robotsRef.current = initRobots(selectedPlant.PLANT_ID, selectedBuilding.id || '', selectedFloor, currentFloorZones);
      setRobotPositions([...robotsRef.current]);
    } else { robotsRef.current = []; setRobotPositions([]); }
  }, [navLevel, selectedFloor, selectedBuilding, selectedPlant, currentFloorZones]);

  useEffect(() => {
    if (navLevel < 3 || currentFloorZones.length === 0) return;
    const id = setInterval(() => {
      robotsRef.current = advanceRobots(robotsRef.current, currentFloorZones, robotRngRef.current);
      setRobotPositions([...robotsRef.current]);
    }, 100);
    return () => clearInterval(id);
  }, [navLevel, currentFloorZones]);

  const layers: any[] = useMemo(() => [
    cartoBasemap(),

    // Level 1: plant markers + labels
    new ScatterplotLayer<PlantRow>({ id:'pi-plants', data: plants,
      getPosition: (d:PlantRow) => [d.LONGITUDE,d.LATITUDE],
      getRadius: (d:PlantRow) => Math.sqrt(d.CAPACITY_BATCHES_MONTH)*8000,
      radiusMinPixels: navLevel===1?20:6, radiusMaxPixels: navLevel===1?55:40,
      getFillColor: (d:PlantRow) => SEVERITY_COLORS[Math.min(4,d.MAX_SEVERITY)] as any,
      getLineColor: [255,255,255,220] as any, lineWidthMinPixels:2, stroked:true, pickable:true,
      onClick: ({object}:any) => object && navLevel===1 && goToCampus(object),
    } as any),
    ...(navLevel===1 ? [new TextLayer<PlantRow>({ id:'pi-labels', data:plants,
      getPosition: (d:PlantRow) => [d.LONGITUDE,d.LATITUDE], getPixelOffset:[0,22] as any,
      getText: (d:PlantRow) => d.PLANT_CODE, getSize:11, getColor:[255,255,255,255] as any,
      background:true, getBackgroundColor: ((d:PlantRow) => { const c=SEVERITY_COLORS[Math.min(4,d.MAX_SEVERITY)]; return [c[0],c[1],c[2],200]; }) as any,
      backgroundPadding:[5,2,5,2], fontFamily:'monospace',
      getAlignmentBaseline:'top', getTextAnchor:'middle', pickable:true,
      onClick: ({object}:any) => object && goToCampus(object),
    } as any)] : []),

    // Level 2+: campus building footprints (extruded only at level 2; flat outlines at 3+)
    ...(navLevel >= 2 && campus.length > 0 ? [new GeoJsonLayer({ id:'pi-campus',
      data: { type:'FeatureCollection', features: campus.map(b => ({ type:'Feature', geometry: b.geojson, properties:{ roleId:b.roleId, role:b.role, id:b.id, alertStatus:b.alertStatus, floorCount:b.floorCount } })) },
      filled:true, extruded:navLevel===2, wireframe:navLevel===2,
      getFillColor: (f:any) => {
        const b = campus.find(x=>x.id===f.properties?.id);
        if (!b) return [100,100,100,navLevel===2?180:20];
        if (navLevel>=3) {
          const isSel = selectedBuilding?.id===b.id;
          return isSel ? [255,255,255,15] : [60,60,60,10];
        }
        const base = b.color as [number,number,number,number];
        const isSelected = selectedBuilding?.id === b.id;
        return isSelected ? [Math.min(255,base[0]+60),Math.min(255,base[1]+60),Math.min(255,base[2]+60),230] : base;
      },
      getLineColor: (f:any) => {
        if (navLevel>=3) { const b=campus.find(x=>x.id===f.properties?.id); return selectedBuilding?.id===b?.id?[255,200,0,200]:[255,255,255,40]; }
        return [255,255,255,120];
      },
      lineWidthMinPixels: navLevel>=3 ? 2 : 2,
      getElevation: (f:any) => { if(navLevel>=3) return 0; const b=campus.find(x=>x.id===f.properties?.id); return b ? b.floorCount*5 : 8; },
      pickable:true,
      onClick: ({object}:any) => { if(object && navLevel===2) { const b=campus.find(x=>x.id===object.properties?.id); if(b) goToBuilding(b); } },
    } as any)] : []),

    // Campus building role labels
    ...(navLevel===2 && campus.length>0 ? [new TextLayer({ id:'pi-bldg-labels',
      data: campus,
      getPosition: (b:any) => { const c:[number,number][]=[]; const ex=(x:any)=>{if(typeof x[0]==='number')c.push(x);else x.forEach(ex);}; try{ex(b.geojson?.coordinates||[]);}catch{} return c.length?[c.reduce((s,p)=>s+p[0],0)/c.length, c.reduce((s,p)=>s+p[1],0)/c.length, b.floorCount*5+1]:null; },
      getText: (b:any) => b.roleShort,
      getSize:13, getColor:[255,255,255,230] as any,
      getTextAnchor:'middle' as any, getAlignmentBaseline:'center' as any,
      background:true, getBackgroundColor:(b:any) => { const c=b.color; return [Math.floor(c[0]*.4),Math.floor(c[1]*.4),Math.floor(c[2]*.4),180]; },
      backgroundPadding:[5,2,5,2], fontFamily:'monospace', fontWeight:'bold' as any, billboard:true,
    } as any)] : []),

    // Level 3: floor plan zones
    ...(navLevel>=3 && currentFloorZones.length>0 ? [new PolygonLayer({ id:'pi-zones',
      data: currentFloorZones,
      getPolygon: (z:any) => z.polygon,
      getElevation: (z:any) => z.elevation,
      getFillColor: (z:any) => {
        const isSelected = selectedRoom?.id===z.id;
        if (navLevel===4) return isSelected ? [255,200,0,60] : [80,80,80,30];
        const base = alertRgba(z.alertStatus);
        return isSelected ? [Math.min(255,base[0]+60),Math.min(255,base[1]+60),Math.min(255,base[2]+60),240] : base;
      },
      getLineColor: (z:any) => navLevel===4 ? ([255,200,0,200] as any) : ([255,255,255,100] as any),
      lineWidthMinPixels: navLevel===4 ? 2 : 1,
      extruded: navLevel!==4, wireframe: navLevel!==4, pickable:true,
      onClick: ({object}:any) => { if(object && navLevel===3) goToRoom(object); else if(object && navLevel===4) setSelectedRoom(object); },
    } as any), new TextLayer({ id:'pi-zone-labels', data:currentFloorZones,
      getPosition:(z:any)=>[...polyCenter(z.polygon), z.elevation+0.5],
      getText:(z:any) => z.name,
      getSize:9, getColor:[255,255,255,210] as any,
      getTextAnchor:'middle' as any, getAlignmentBaseline:'center' as any,
      background:true, getBackgroundColor:(z:any)=>{ const c=alertRgba(z.alertStatus); return [Math.floor(c[0]*.3),Math.floor(c[1]*.3),Math.floor(c[2]*.3),180]; },
      backgroundPadding:[3,1,3,1], billboard:true, fontFamily:'monospace',
    } as any)] : []),

    // Level 3: sensor markers
    ...(navLevel>=3 && currentFloorZones.length>0 ? [new ScatterplotLayer({ id:'pi-sensors',
      data: currentFloorZones.flatMap((z:any) => z.sensors?.map((s:any) => ({
        ...s, zoneId:z.id,
        position: [lerp2(polyCenter(z.polygon)[0], s._lon ?? 0, 0.3), lerp2(polyCenter(z.polygon)[1], s._lat ?? 0, 0.3)]
      })) || []),
      getPosition: (s:any) => { const z=currentFloorZones.find((x:any)=>x.id===s.zoneId); const c=z?polyCenter(z.polygon):[0,0]; return [...c, 0.3] as any; },
      getFillColor:(s:any)=>(s.status==='critical'?[239,68,68,255]:s.status==='warning'?[249,115,22,255]:[34,197,94,255]),
      getRadius:1.5, radiusMinPixels:6, radiusMaxPixels:10,
      getLineColor:[255,255,255,180] as any, lineWidthMinPixels:1.5, stroked:true, pickable:true,
    } as any)] : []),

    // Level 4: room contents — rack rows, equipment footprints, lab benches
    ...(navLevel===4 && selectedRoom ? (() => buildRoomVisuals(selectedRoom, PolygonLayer, TextLayer))() : []),

    // Level 3+: animated robots
    ...(navLevel>=3 && robotPositions.length>0 ? [new ScatterplotLayer({
      id:'pi-robots', data: navLevel===4 && selectedRoom
        ? robotPositions.filter((r:any) => r.fromZone===selectedRoom.id || r.toZone===selectedRoom.id)
        : robotPositions,
      getPosition: (r:any) => { const [ln,la]=getRobotPos(r, currentFloorZones); return [ln,la,r.elev]; },
      getFillColor: (r:any) => r.status==='charging'?[100,100,100,180]:r.status==='error'?[239,68,68,240]:r.color,
      getRadius: (r:any) => r.type==='AGV'?2:1.5,
      radiusMinPixels:6, radiusMaxPixels:12,
      getLineColor:[255,255,255,200] as any, lineWidthMinPixels:2, stroked:true, pickable:true,
    } as any)] : []),
  // eslint-disable-next-line react-hooks/exhaustive-deps
  ], [plants, navLevel, campus, selectedBuilding, selectedFloor, currentFloorZones, selectedRoom, robotPositions]);

  const breadcrumb = [
    selectedPlant?.PLANT_NAME,
    selectedBuilding?.role,
    selectedBuilding?.floors?.[selectedFloor]?.label,
    selectedRoom?.name,
  ].filter(Boolean).join(' › ');

  return (
    <div style={{ width:'100%', height:'100%', position:'relative', background:'#0f1117', borderRadius:8, overflow:'hidden' }}>
      <DeckGL viewState={viewState} onViewStateChange={({viewState:vs}:any)=>setViewState(vs)}
        controller layers={layers}
        getTooltip={({object}:any) => {
          if (!object) return null;
          if (object.PLANT_NAME) { const s=Math.min(4,object.MAX_SEVERITY??0); return {html:`<div style="font-size:12px;padding:5px 9px"><b>${object.PLANT_NAME}</b><br/>${object.CITY}<br/><span style="color:${SEVERITY_HEX[s]}">${SEVERITY_LABELS[s]}</span></div>`}; }
          if (object.properties?.roleId) { const b=campus.find(x=>x.id===object.properties?.id); const c=alertColor(b?.alertStatus||'ok'); return {html:`<div style="font-size:12px;padding:5px 9px"><b>${object.properties.role}</b><br/>${b?.floorCount} floor(s) · ${Math.round(b?.areaSqm||0).toLocaleString()} m²<br/><span style="color:${c}">${b?.alertStatus?.toUpperCase()}</span><br/><i>Click to inspect</i></div>`}; }
          if (object.polygon && object.name) { const c=alertColor(object.alertStatus); return {html:`<div style="font-size:12px;padding:5px 9px"><b>${object.name}</b><br/><span style="color:${c}">${object.alertStatus?.toUpperCase()}</span><br/>${navLevel===3?'<i>Click to enter room</i>':''}</div>`}; }
          if (object.status !== undefined && object.zoneId) { const c=alertColor(object.status); return {html:`<div style="font-size:12px;padding:5px 9px"><b>${object.name}</b><br/><span style="color:${c};font-weight:700">${object.value}${object.unit}</span>${object.alert?`<br/><span style="color:#f97316">⚠ ${object.alert}</span>`:''}</div>`}; }
          if (object.expiryDate) { const c=alertColor(object.expiryStatus||'ok'); return {html:`<div style="font-size:12px;padding:5px 9px"><b>${object.name||object.id}</b><br/>${object.product||''}<br/>Batch: ${object.batchNo||'-'} · ${object.pallets||''}<br/>Expires: ${object.expiryDate}<br/><span style="color:${c}">${object.daysLeft}d remaining</span>${object.temperature?`<br/>Temp: ${object.temperature}`:''}</div>`}; }
          if (object.id && !object.alertStatus && !object.properties) { const c=object.status==='Fault'||object.status==='Alarm'?'#ef4444':object.status==='Maintenance'||object.status==='Changeover'||object.status==='On Battery'?'#f97316':'#22c55e'; const lines=[object.role&&`Role: ${object.role}`,object.model&&`Model: ${object.model}`,object.status&&`Status: <span style="color:${c}">${object.status}</span>`,object.capacity&&`Capacity: ${object.capacity}`,object.batch&&`Batch: ${object.batch}`,object.temperature&&`Temp: ${object.temperature}`,object.pressure&&`Pressure: ${object.pressure}`,object.airflow&&`Airflow: ${object.airflow}`,object.load&&`Load: ${object.load}`,object.daysLeft!=null&&`${object.daysLeft}d remaining`,].filter(Boolean); return {html:`<div style="font-size:12px;padding:5px 9px"><b>${object.name||object.id}</b>${lines.length?`<br/>${lines.join('<br/>')}`:''}${object.alert?`<br/><span style="color:#f97316">⚠ ${object.alert}</span>`:''}</div>`}; }
          if (object.type && (object.type==='AGV'||object.type==='INSPECT'||object.type==='CLEAN')) { const bc=object.battery<20?'#ef4444':object.battery<50?'#f97316':'#22c55e'; const rt=ROBOT_TYPES.find(x=>x.type===object.type); return {html:`<div style="font-size:12px;padding:5px 9px"><b>${object.id}</b> <span style="opacity:0.7">${rt?.label||object.type}</span><br/>${object.task}<br/><span style="color:${bc}">🔋 ${Math.round(object.battery)}%</span>${object.status==='charging'?' <span style="color:#64748b">● Charging</span>':object.status==='error'?' <span style="color:#ef4444">● Error</span>':''}</div>`}; }
          return null;
        }}
      />

      {/* Robot legend */}
      {navLevel>=3 && robotPositions.length>0 && (
        <div style={{ position:'absolute', bottom:10, right:10, background:'rgba(0,0,0,0.75)', backdropFilter:'blur(6px)', borderRadius:8, padding:'7px 11px' }}>
          <div style={{ fontSize:9, color:'#888', marginBottom:4, textTransform:'uppercase', letterSpacing:0.5 }}>Floor Robots</div>
          {ROBOT_TYPES.map(rt => { const cnt = robotPositions.filter((r:any)=>r.type===rt.type).length; if(!cnt) return null; return (
            <div key={rt.type} style={{ display:'flex', alignItems:'center', gap:6, padding:'2px 0' }}>
              <div style={{ width:8, height:8, borderRadius:'50%', background:`rgb(${rt.color[0]},${rt.color[1]},${rt.color[2]})`, flexShrink:0 }} />
              <span style={{ fontSize:10, color:'#ddd' }}>{rt.label} ({cnt})</span>
            </div>
          ); })}
        </div>
      )}

      {/* Back button */}
      {navLevel > 1 && (
        <button onClick={goBack} style={{ position:'absolute', top:10, left:10, background:'rgba(0,0,0,0.78)', color:'#fff', border:'1px solid rgba(255,255,255,0.2)', borderRadius:6, padding:'5px 12px', cursor:'pointer', fontSize:12, backdropFilter:'blur(6px)' }}>
          ← {navLevel===4?'Room List':navLevel===3?'Campus':navLevel===2?'All Plants':''}
        </button>
      )}

      {/* Breadcrumb */}
      {breadcrumb && (
        <div style={{ position:'absolute', top:10, left:'50%', transform:'translateX(-50%)', background:'rgba(0,0,0,0.75)', color:'#ddd', padding:'4px 14px', borderRadius:6, fontSize:11, backdropFilter:'blur(6px)', whiteSpace:'nowrap', maxWidth:'60%', overflow:'hidden', textOverflow:'ellipsis' }}>
          {breadcrumb}
        </div>
      )}

      {/* Floor selector (level 3) */}
      {navLevel===3 && selectedBuilding && (
        <div style={{ position:'absolute', top:10, right:10, background:'rgba(0,0,0,0.78)', borderRadius:8, padding:'8px 10px', backdropFilter:'blur(6px)' }}>
          <div style={{ fontSize:10, color:'#888', marginBottom:5, textTransform:'uppercase', letterSpacing:0.5 }}>Floor</div>
          {selectedBuilding.floors?.map((f:any, i:number) => (
            <button key={i} onClick={()=>setSelectedFloor(i)} style={{ display:'block', width:'100%', padding:'4px 10px', marginBottom:3, borderRadius:4, border:'none', background:selectedFloor===i?'#29b5e8':'rgba(255,255,255,0.08)', color:selectedFloor===i?'#fff':'#aaa', cursor:'pointer', fontSize:11, textAlign:'left', whiteSpace:'nowrap' }}>
              {f.label}
            </button>
          ))}
        </div>
      )}

      {/* Plant list overlay (level 1) */}
      {navLevel===1 && plants.length>0 && (
        <div style={{ position:'absolute', top:10, right:10, background:'rgba(0,0,0,0.75)', backdropFilter:'blur(6px)', borderRadius:8, padding:'8px 12px', minWidth:160 }}>
          <div style={{ fontSize:10, color:'#888', marginBottom:5, fontWeight:600, textTransform:'uppercase', letterSpacing:0.5 }}>Plants</div>
          {plants.map(p => { const s=Math.min(4,p.MAX_SEVERITY); return (
            <div key={p.PLANT_ID} onClick={()=>goToCampus(p)} style={{ display:'flex', alignItems:'center', gap:7, padding:'3px 0', cursor:'pointer' }}>
              <div style={{ width:8, height:8, borderRadius:'50%', background:SEVERITY_HEX[s], flexShrink:0 }} />
              <span style={{ fontSize:11, color:'#ddd' }}>{p.PLANT_NAME}</span>
            </div>
          ); })}
        </div>
      )}

      {/* Level 2: campus building legend */}
      {navLevel===2 && campus.length>0 && (
        <div style={{ position:'absolute', bottom:10, left:10, background:'rgba(0,0,0,0.75)', backdropFilter:'blur(6px)', borderRadius:8, padding:'8px 12px' }}>
          {campus.map((b:any) => { const c=alertColor(b.alertStatus); return (
            <div key={b.id} onClick={()=>goToBuilding(b)} style={{ display:'flex', alignItems:'center', gap:7, padding:'3px 0', cursor:'pointer' }}>
              <div style={{ width:10, height:10, borderRadius:2, background:`rgb(${b.color[0]},${b.color[1]},${b.color[2]})`, flexShrink:0 }} />
              <span style={{ fontSize:11, color:'#ddd', flex:1 }}>{b.role}</span>
              <span style={{ width:6, height:6, borderRadius:'50%', background:c, flexShrink:0 }} />
            </div>
          ); })}
        </div>
      )}

      {/* Click hint */}
      {navLevel===2 && !loading && (
        <div style={{ position:'absolute', bottom:10, left:'50%', transform:'translateX(-50%)', background:'rgba(41,181,232,0.85)', color:'#fff', padding:'5px 14px', borderRadius:14, fontSize:11, fontWeight:600, pointerEvents:'none', whiteSpace:'nowrap' }}>
          Click a building to inspect floor plan
        </div>
      )}
      {navLevel===3 && !loading && (
        <div style={{ position:'absolute', bottom:10, left:'50%', transform:'translateX(-50%)', background:'rgba(41,181,232,0.85)', color:'#fff', padding:'5px 14px', borderRadius:14, fontSize:11, fontWeight:600, pointerEvents:'none', whiteSpace:'nowrap' }}>
          Click a room to see contents &amp; sensors
        </div>
      )}
      {onBuildingSelect && navLevel===2 && (
        <div style={{ position:'absolute', bottom:36, left:'50%', transform:'translateX(-50%)', background:'rgba(168,85,247,0.85)', color:'#fff', padding:'4px 12px', borderRadius:14, fontSize:11, fontWeight:600, pointerEvents:'none', whiteSpace:'nowrap' }}>
          🤖 Click a building to ask the agent
        </div>
      )}
      {onRoomSelect && navLevel===3 && (
        <div style={{ position:'absolute', bottom:36, left:'50%', transform:'translateX(-50%)', background:'rgba(168,85,247,0.85)', color:'#fff', padding:'4px 12px', borderRadius:14, fontSize:11, fontWeight:600, pointerEvents:'none', whiteSpace:'nowrap' }}>
          🤖 Click a room to ask the agent
        </div>
      )}

      {loading && (
        <div style={{ position:'absolute', top:'50%', left:'50%', transform:'translate(-50%,-50%)', background:'rgba(0,0,0,0.85)', color:'#fff', padding:'12px 22px', borderRadius:8, fontSize:13 }}>
          Loading campus data…
        </div>
      )}
    </div>
  );
}

function lerp2(a: number, b: number, t: number) { return a+(b-a)*t; }

// ── Robot simulation helpers ──────────────────────────────────────────────────

const ROBOT_TYPES = [
  { type:'AGV',     label:'Transport AGV',     color:[59,130,246,240] as [number,number,number,number], elev:0.8, speed:0.006, count:2 },
  { type:'INSPECT', label:'Inspection Robot',  color:[250,204,21,240] as [number,number,number,number], elev:2.5, speed:0.004, count:1 },
  { type:'CLEAN',   label:'Cleaning Robot',    color:[156,163,175,220] as [number,number,number,number], elev:0.4, speed:0.003, count:1 },
];

const ROBOT_TASKS: Record<string, (from:string, to:string) => string> = {
  AGV:     (f,t) => `Transporting batch to ${t}`,
  INSPECT: (f,t) => `Sensor patrol — ${f}`,
  CLEAN:   (f,t) => `Sanitising ${f}`,
};

function rng2(seed: number) {
  let s = seed | 0;
  return () => { s = (s * 1664525 + 1013904223) | 0; return (s >>> 0) / 0xffffffff; };
}

function initRobots(plantId: number, buildingKey: string, floorIdx: number, zones: any[]): any[] {
  if (!zones.length) return [];
  const r = rng2(plantId * 37 + (buildingKey.charCodeAt(0) || 1) * 13 + floorIdx * 7 + 999);
  const robots: any[] = [];
  ROBOT_TYPES.forEach(({ type, color, elev, speed, count }) => {
    for (let i = 0; i < count; i++) {
      const fi = Math.floor(r() * zones.length);
      const ti = Math.floor(r() * zones.length);
      const fromZ = zones[fi];
      const toZ   = zones[ti];
      robots.push({
        id: `${type}-${String.fromCharCode(65 + robots.length)}`,
        type, color, elev,
        fromZone: fromZ.id, toZone: toZ.id,
        progress: r(),
        speed: speed * (0.8 + r() * 0.4),
        battery: Math.round(25 + r() * 75),
        status: 'moving',
        task: ROBOT_TASKS[type](fromZ.name, toZ.name),
      });
    }
  });
  return robots;
}

function getRobotPos(robot: any, zones: any[]): [number, number] {
  const fromZ = zones.find((z:any) => z.id === robot.fromZone);
  const toZ   = zones.find((z:any) => z.id === robot.toZone);
  if (!fromZ || !toZ) return [0, 0];
  const [fx, fy] = polyCenter(fromZ.polygon);
  const [tx, ty] = polyCenter(toZ.polygon);
  return [lerp2(fx, tx, robot.progress), lerp2(fy, ty, robot.progress)];
}

function advanceRobots(robots: any[], zones: any[], r: () => number): any[] {
  return robots.map(rb => {
    const np = rb.progress + rb.speed;
    if (np >= 1) {
      const nextIdx = Math.floor(r() * zones.length);
      const nz = zones[nextIdx];
      return { ...rb, fromZone: rb.toZone, toZone: nz.id, progress: 0,
        battery: Math.max(5, rb.battery - 0.05),
        status: rb.battery < 10 ? 'charging' : 'moving',
        task: ROBOT_TASKS[rb.type](zones.find((z:any)=>z.id===rb.toZone)?.name||'', nz.name) };
    }
    return { ...rb, progress: np };
  });
}

function buildRoomVisuals(zone: any, PolygonLayerClass: any, TextLayerClass: any): any[] {
  const items = zone.contents?.items || [];
  const poly = zone.polygon;
  if (!poly?.length) return [];
  const minLon = Math.min(...poly.map((p: any) => p[0])), maxLon = Math.max(...poly.map((p: any) => p[0]));
  const minLat = Math.min(...poly.map((p: any) => p[1])), maxLat = Math.max(...poly.map((p: any) => p[1]));
  const type = zone.type || 'warehouse';
  const L = (x: number) => lerp2(minLon, maxLon, x);
  const La = (y: number) => lerp2(minLat, maxLat, y);
  const R = (x0: number, x1: number, y0: number, y1: number): [number,number][] => [[L(x0),La(y0)],[L(x1),La(y0)],[L(x1),La(y1)],[L(x0),La(y1)],[L(x0),La(y0)]];
  const isRacking = ['warehouse','chill','deep_freeze','freezer','storage','quarantine','dispensary','hazardous'].includes(type);
  const isProduction = ['reactor','process','aseptic','packaging','granulation','dock'].includes(type);
  const isLab = ['lab','analytical','precision','qc','utility','hvac','electrical','control','cleanroom'].includes(type);
  const polys: any[] = [];
  const labels: any[] = [];
  const p = (polygon: [number,number][], elevation: number, color: [number,number,number,number], data = {}) => polys.push({ polygon, elevation, color, ...data });
  const lbl = (lon: number, lat: number, text: string, size = 8, elevation = 0.5) => labels.push({ position: [lon, lat, elevation], text, size });

  if (isRacking) {
    p(R(0,1,0,1), 0.1, [30,30,30,120]);
    p(R(0,1,0.28,0.32), 0.15, [200,180,0,100]);
    p(R(0,1,0.60,0.64), 0.15, [200,180,0,100]);
    const RACK_ROWS: [number,number,number,number][] = [[0.02,0.98,0.05,0.27],[0.02,0.98,0.33,0.58],[0.02,0.98,0.65,0.90]];
    const slotsPerRow = Math.max(4, Math.ceil(items.length / 3));
    if (items.length > 0) {
      items.forEach((item: any, idx: number) => {
        const rowIdx = Math.floor(idx / slotsPerRow), colIdx = idx % slotsPerRow;
        if (rowIdx >= 3) return;
        const [rx0,rx1,ry0,ry1] = RACK_ROWS[rowIdx];
        const slotW = (rx1-rx0)/slotsPerRow;
        const gx0=rx0+colIdx*slotW+0.004, gx1=rx0+(colIdx+1)*slotW-0.004;
        const s = item.expiryStatus||item.status||'ok';
        const c: [number,number,number,number] = s==='critical'?[239,68,68,220]:s==='warning'?[249,115,22,200]:[41,181,232,180];
        const elev = s==='critical'?4.5:s==='warning'?3:2;
        p(R(gx0,gx1,ry0+0.02,ry1-0.02), elev, c, item);
        p(R(gx0,gx0+0.003,ry0,ry1), elev+0.5, [60,60,60,200]);
        p(R(gx1-0.003,gx1,ry0,ry1), elev+0.5, [60,60,60,200]);
        lbl(L((gx0+gx1)/2), La((ry0+ry1)/2), (item.name||item.id||'').slice(0,10), 8, elev+0.6);
      });
    } else {
      RACK_ROWS.forEach(([rx0,rx1,ry0,ry1]) => p(R(rx0,rx1,ry0,ry1), 2, [41,181,232,80]));
    }
    p(R(0.02,0.98,0.92,0.98), 1, [70,90,70,160]);
    lbl(L(0.5), La(0.95), 'STAGING', 9, 1.5);
  } else if (isProduction) {
    p(R(0,1,0,1), 0.1, [25,25,35,150]);
    const eq: [number,number,number,number][] = [[0.05,0.45,0.08,0.58],[0.55,0.95,0.08,0.48],[0.55,0.95,0.55,0.92],[0.05,0.45,0.65,0.92]];
    const renderItems = items.length > 0 ? items : [null,null,null,null];
    renderItems.slice(0,4).forEach((item: any, idx: number) => {
      const [ex0,ex1,ey0,ey1] = eq[idx]||eq[0];
      const s = item ? (item.status==='Fault'?'critical':item.status==='Maintenance'||item.status==='Changeover'?'warning':'ok') : 'ok';
      const c: [number,number,number,number] = s==='critical'?[239,68,68,200]:s==='warning'?[249,115,22,180]:[107,114,128,200];
      const elev=idx===0?8:idx===1?6:idx===2?5:4;
      p(R(ex0+0.02,ex1-0.02,ey0+0.02,ey1-0.02), elev, c, item||{});
      p(R(ex0,ex1,ey0,ey1), 0.2, [255,255,255,20]);
      if (item) lbl(L((ex0+ex1)/2), La((ey0+ey1)/2), (item.name||item.id||'').slice(0,12), 9, elev+1);
    });
    p(R(0.46,0.54,0.05,0.95), 0.15, [200,180,0,80]);
  } else if (isLab) {
    p(R(0,1,0,1), 0.1, [20,30,40,160]);
    p(R(0.02,0.98,0.03,0.14), 1.5, [59,130,246,180]);
    p(R(0.02,0.98,0.86,0.97), 1.5, [59,130,246,180]);
    p(R(0.02,0.14,0.15,0.84), 1.5, [59,130,246,180]);
    p(R(0.86,0.98,0.15,0.84), 1.5, [59,130,246,180]);
    p(R(0.30,0.70,0.30,0.70), 1.2, [41,181,232,160]);
    const pos: [number,number,number,number][] = [[0.15,0.35,0.04,0.13],[0.40,0.60,0.04,0.13],[0.15,0.35,0.87,0.96],[0.65,0.80,0.04,0.13]];
    const renderItems = items.length > 0 ? items : [null,null,null,null];
    renderItems.slice(0,4).forEach((item: any, idx: number) => {
      const [ix0,ix1,iy0,iy1] = pos[idx]||pos[0];
      const c: [number,number,number,number] = item && (item.status==='Maintenance'||item.status==='Fault') ? [249,115,22,200] : [234,179,8,200];
      p(R(ix0,ix1,iy0,iy1), 2.5, c, item||{});
      if (item) lbl(L((ix0+ix1)/2), La((iy0+iy1)/2), (item.name||item.id||'').slice(0,10), 7, 3);
    });
    lbl(L(0.5), La(0.5), 'WORKSPACE', 9, 1.5);
  } else {
    p(R(0,1,0,1), 0.1, [30,30,30,120]);
    if (items.length > 0) {
      const gc=Math.ceil(Math.sqrt(items.length)), gr=Math.ceil(items.length/gc);
      items.forEach((item: any, i: number) => {
        const row=Math.floor(i/gc),col=i%gc,pad=0.06;
        const x0=col/gc+pad/gc,x1=(col+1)/gc-pad/gc,y0=row/gr+pad/gr,y1=(row+1)/gr-pad/gr;
        const s=item.expiryStatus||item.status||'ok';
        const c: [number,number,number,number] = s==='critical'?[239,68,68,200]:s==='warning'?[249,115,22,180]:[41,181,232,160];
        p(R(x0,x1,y0,y1), 2, c, item);
        lbl(L((x0+x1)/2), La((y0+y1)/2), (item.name||item.id||'').slice(0,10), 8, 2.5);
      });
    } else {
      p(R(0.05,0.95,0.05,0.95), 1, [41,181,232,60]);
      lbl(L(0.5), La(0.5), zone.name||zone.type||'ZONE', 11, 1.5);
    }
  }
  return [
    new PolygonLayerClass({ id:'pi-contents', data:polys,
      getPolygon:(d:any)=>d.polygon, getElevation:(d:any)=>d.elevation,
      getFillColor:(d:any)=>d.color,
      getLineColor:[255,255,255,60] as any, lineWidthMinPixels:1,
      extruded:true, wireframe:false, filled:true, stroked:true, pickable:true,
    } as any),
    new TextLayerClass({ id:'pi-content-labels', data:labels,
      getPosition:(d:any)=>d.position,
      getText:(d:any)=>d.text, getSize:(d:any)=>d.size||8,
      getColor:[255,255,255,230] as any,
      getTextAnchor:'middle' as any, getAlignmentBaseline:'center' as any,
      fontFamily:'monospace', billboard:true,
    } as any),
  ];
}

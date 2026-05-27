import { useState, useCallback, useEffect, useMemo } from 'react';
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

export default function PlantIntelMap() {
  const [plants, setPlants] = useState<PlantRow[]>([]);
  const [navLevel, setNavLevel] = useState<NavLevel>(1);
  const [selectedPlant, setSelectedPlant] = useState<PlantRow | null>(null);
  const [campus, setCampus] = useState<any[]>([]);
  const [selectedBuilding, setSelectedBuilding] = useState<any | null>(null);
  const [selectedFloor, setSelectedFloor] = useState(0);
  const [selectedRoom, setSelectedRoom] = useState<any | null>(null);
  const [loading, setLoading] = useState(false);
  const [viewState, setViewState] = useState<any>(WORLD_VIEW);

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
  }, []);

  // Level 3 → 4: drill into room
  const goToRoom = useCallback((zone: any) => {
    if (!zone.polygon?.length) return;
    const [lon, lat] = polyCenter(zone.polygon);
    setViewState({ longitude: lon, latitude: lat, zoom: 20, pitch: 0, bearing: 0, transitionDuration: 800 });
    setSelectedRoom(zone); setNavLevel(4);
  }, []);

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

    // Level 2+: campus building footprints (all shown)
    ...(navLevel >= 2 && campus.length > 0 ? [new GeoJsonLayer({ id:'pi-campus',
      data: { type:'FeatureCollection', features: campus.map(b => ({ type:'Feature', geometry: b.geojson, properties:{ roleId:b.roleId, role:b.role, id:b.id, alertStatus:b.alertStatus, floorCount:b.floorCount } })) },
      filled:true, extruded:true, wireframe:true,
      getFillColor: (f:any) => {
        const b = campus.find(x=>x.id===f.properties?.id);
        if (!b) return [100,100,100,180];
        const base = b.color as [number,number,number,number];
        const isSelected = selectedBuilding?.id === b.id;
        return isSelected ? [Math.min(255,base[0]+60),Math.min(255,base[1]+60),Math.min(255,base[2]+60),230] : base;
      },
      getLineColor: [255,255,255,120] as any, lineWidthMinPixels:2,
      getElevation: (f:any) => { const b=campus.find(x=>x.id===f.properties?.id); return b ? b.floorCount*5 : 8; },
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
        const base = alertRgba(z.alertStatus);
        return isSelected ? [Math.min(255,base[0]+60),Math.min(255,base[1]+60),Math.min(255,base[2]+60),240] : base;
      },
      getLineColor: [255,255,255,100] as any, lineWidthMinPixels:1,
      extruded:true, wireframe:true, pickable:true,
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

    // Level 4: room contents (flat view)
    ...(navLevel===4 && selectedRoom ? (() => {
      const items = selectedRoom.contents?.items || [];
      if (!items.length) return [];
      const poly = selectedRoom.polygon;
      const minLon = Math.min(...poly.map((p:any)=>p[0]));
      const maxLon = Math.max(...poly.map((p:any)=>p[0]));
      const minLat = Math.min(...poly.map((p:any)=>p[1]));
      const maxLat = Math.max(...poly.map((p:any)=>p[1]));
      const cols = Math.ceil(Math.sqrt(items.length));
      const rows = Math.ceil(items.length/cols);
      const itemPolygons = items.map((item:any,i:number) => {
        const row=Math.floor(i/cols), col=i%cols;
        const pad=0.08;
        const x0=lerp2(minLon,maxLon,(col+pad)/cols); const x1=lerp2(minLon,maxLon,(col+1-pad)/cols);
        const y0=lerp2(minLat,maxLat,(row+pad)/rows); const y1=lerp2(minLat,maxLat,(row+1-pad)/rows);
        const expStatus = item.expiryStatus || 'ok';
        return { ...item, polygon:[[x0,y0],[x1,y0],[x1,y1],[x0,y1],[x0,y0]] as [number,number][], alertStatus:expStatus };
      });
      return [
        new PolygonLayer({ id:'pi-contents',
          data: itemPolygons,
          getPolygon:(d:any)=>d.polygon, getElevation:()=>0.5,
          getFillColor:(d:any)=>alertRgba(d.alertStatus||'ok'),
          getLineColor:[255,255,255,80] as any, lineWidthMinPixels:1,
          extruded:false, filled:true, stroked:true, pickable:true,
        } as any),
        new TextLayer({ id:'pi-content-labels',
          data: itemPolygons,
          getPosition:(d:any)=>polyCenter(d.polygon),
          getText:(d:any)=>(d.name||d.id||'').slice(0,14),
          getSize:9, getColor:[255,255,255,220] as any,
          getTextAnchor:'middle' as any, getAlignmentBaseline:'center' as any,
          fontFamily:'monospace', billboard:true,
        } as any),
      ];
    })() : []),
  // eslint-disable-next-line react-hooks/exhaustive-deps
  ], [plants, navLevel, campus, selectedBuilding, selectedFloor, currentFloorZones, selectedRoom]);

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
          if (object.expiryDate) { const c=alertColor(object.expiryStatus||'ok'); return {html:`<div style="font-size:12px;padding:5px 9px"><b>${object.name||object.id}</b><br/>${object.product||''}<br/>Expires: ${object.expiryDate}<br/><span style="color:${c}">${object.daysLeft}d remaining</span></div>`}; }
          return null;
        }}
      />

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

      {loading && (
        <div style={{ position:'absolute', top:'50%', left:'50%', transform:'translate(-50%,-50%)', background:'rgba(0,0,0,0.85)', color:'#fff', padding:'12px 22px', borderRadius:8, fontSize:13 }}>
          Loading campus data…
        </div>
      )}
    </div>
  );
}

function lerp2(a: number, b: number, t: number) { return a+(b-a)*t; }

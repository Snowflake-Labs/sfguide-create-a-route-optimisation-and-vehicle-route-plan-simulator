import { useState, useCallback, useEffect, useMemo } from 'react';
import DeckGL from '@deck.gl/react';
import { ScatterplotLayer, GeoJsonLayer, TextLayer, PolygonLayer } from '@deck.gl/layers';
import { BitmapLayer } from '@deck.gl/layers';
import { TileLayer } from '@deck.gl/geo-layers';

const CARTO_LIGHT = '/api/tiles/{z}/{x}/{y}';
function cartoBasemap() {
  return new TileLayer({
    id: 'carto-basemap-pi', data: CARTO_LIGHT, minZoom: 0, maxZoom: 19, tileSize: 256,
    renderSubLayers: (props: any) => {
      const { boundingBox } = props.tile;
      return new BitmapLayer(props, { data: undefined, image: props.data, bounds: [boundingBox[0][0], boundingBox[0][1], boundingBox[1][0], boundingBox[1][1]] });
    }
  });
}

const SEVERITY_COLORS: [number, number, number, number][] = [
  [34, 197, 94, 220], [234, 179, 8, 220], [249, 115, 22, 220], [239, 68, 68, 220], [185, 28, 28, 220],
];
const SEVERITY_HEX = ['#22c55e', '#eab308', '#f97316', '#ef4444', '#b91c1c'];
const SEVERITY_LABELS = ['OK', 'Low', 'Moderate', 'High', 'Critical'];
const WORLD_VIEW = { longitude: 20, latitude: 25, zoom: 1.4, pitch: 0, bearing: 0 };

interface PlantRow { PLANT_ID: number; PLANT_NAME: string; PLANT_CODE: string; CITY: string; COUNTRY: string; LATITUDE: number; LONGITUDE: number; MAX_SEVERITY: number; CAPACITY_BATCHES_MONTH: number; }
interface WarehouseZone { id: string; name: string; type: string; polygon: [number,number][]; elevation: number; alertStatus: string; temperature: number; targetTemp: number | null; humidity: number; color: [number,number,number,number]; inventory: any[]; }
interface WarehouseSensor { id: string; name: string; zoneId: string; position: [number,number]; type: string; value: number; unit: string; status: string; alert: string | null; }

export default function PlantIntelMap() {
  const [plants, setPlants]         = useState<PlantRow[]>([]);
  const [selected, setSelected]     = useState<PlantRow | null>(null);
  const [building, setBuilding]     = useState<any>(null);
  const [warehouseMode, setWarehouseMode] = useState(false);
  const [warehouseData, setWarehouseData] = useState<{ zones: WarehouseZone[]; sensors: WarehouseSensor[] } | null>(null);
  const [selectedZone, setSelectedZone] = useState<string | null>(null);
  const [loading, setLoading]       = useState(false);
  const [viewState, setViewState]   = useState<any>(WORLD_VIEW);

  useEffect(() => {
    fetch('/api/plant-intel/plants')
      .then(r => r.json())
      .then((data: any) => setPlants(Array.isArray(data) ? data.map((r: any) => ({
        ...r,
        LATITUDE: Number(r.LATITUDE), LONGITUDE: Number(r.LONGITUDE),
        PLANT_ID: Number(r.PLANT_ID), MAX_SEVERITY: Number(r.MAX_SEVERITY ?? 0),
        CAPACITY_BATCHES_MONTH: Number(r.CAPACITY_BATCHES_MONTH ?? 0),
      })) : []))
      .catch(console.error);
  }, []);

  const selectPlant = useCallback(async (plant: PlantRow) => {
    setSelected(plant); setBuilding(null); setWarehouseMode(false); setWarehouseData(null); setSelectedZone(null);
    setViewState({ longitude: plant.LONGITUDE, latitude: plant.LATITUDE, zoom: 15, pitch: 45, bearing: -15, transitionDuration: 1200 });
    setLoading(true);
    try {
      const bld = await fetch(`/api/plant-intel/buildings?plant_id=${plant.PLANT_ID}`).then(r => r.json());
      setBuilding(bld);
    } catch (e) { console.error(e); }
    setLoading(false);
  }, []);

  const drillWarehouse = useCallback(async (plant: PlantRow, feat: any) => {
    const coords: [number,number][] = [];
    const ex = (c: any) => { if (typeof c[0] === 'number') coords.push(c); else c.forEach(ex); };
    try { ex(feat.geometry?.coordinates || []); } catch {}
    if (coords.length) {
      const lon = coords.reduce((s, c) => s + c[0], 0) / coords.length;
      const lat = coords.reduce((s, c) => s + c[1], 0) / coords.length;
      setViewState({ longitude: lon, latitude: lat, zoom: 19, pitch: 60, bearing: -20, transitionDuration: 1500 });
    }
    setLoading(true);
    try {
      const wd = await fetch(`/api/plant-intel/warehouse?plant_id=${plant.PLANT_ID}`).then(r => r.json());
      setWarehouseData(wd); setWarehouseMode(true);
    } catch (e) { console.error(e); }
    setLoading(false);
  }, []);

  const resetView = useCallback(() => {
    setSelected(null); setBuilding(null); setWarehouseMode(false); setWarehouseData(null); setSelectedZone(null);
    setViewState({ ...WORLD_VIEW, transitionDuration: 800 });
  }, []);

  const exitWarehouse = useCallback(() => {
    if (!selected) return;
    setWarehouseMode(false); setWarehouseData(null); setSelectedZone(null);
    setViewState({ longitude: selected.LONGITUDE, latitude: selected.LATITUDE, zoom: 15, pitch: 45, bearing: -15, transitionDuration: 800 });
  }, [selected]);

  const layers: any[] = useMemo(() => [
    cartoBasemap(),
    new ScatterplotLayer<PlantRow>({
      id: 'pi-plants', data: plants,
      getPosition: (d: PlantRow) => [d.LONGITUDE, d.LATITUDE],
      getRadius: (d: PlantRow) => Math.sqrt(d.CAPACITY_BATCHES_MONTH) * 8000,
      radiusMinPixels: selected ? 6 : 20, radiusMaxPixels: selected ? 40 : 55,
      getFillColor: (d: PlantRow) => SEVERITY_COLORS[Math.min(4, d.MAX_SEVERITY)] as any,
      getLineColor: [255, 255, 255, 220] as any,
      lineWidthMinPixels: 2, stroked: true, pickable: true,
      onClick: ({ object }: any) => object && selectPlant(object),
    } as any),
    ...(!selected ? [new TextLayer<PlantRow>({
      id: 'pi-labels', data: plants,
      getPosition: (d: PlantRow) => [d.LONGITUDE, d.LATITUDE],
      getPixelOffset: [0, 24] as any,
      getText: (d: PlantRow) => d.PLANT_CODE, getSize: 11,
      getColor: [255, 255, 255, 255] as any, background: true,
      getBackgroundColor: ((d: PlantRow) => { const c = SEVERITY_COLORS[Math.min(4, d.MAX_SEVERITY)]; return [c[0], c[1], c[2], 200]; }) as any,
      backgroundPadding: [5, 2, 5, 2], fontFamily: 'monospace',
      getAlignmentBaseline: 'top', getTextAnchor: 'middle',
      pickable: true, onClick: ({ object }: any) => object && selectPlant(object),
    } as any)] : []),
    ...(selected && building && !warehouseMode ? [new GeoJsonLayer({
      id: 'pi-building', data: building,
      filled: true, extruded: true, wireframe: true,
      getFillColor: [41, 181, 232, 200] as any,
      getLineColor: [255, 255, 255, 200] as any, lineWidthMinPixels: 2,
      getElevation: (f: any) => (f.properties?.height ? Number(f.properties.height) * 1.5 : 15),
      pickable: true,
      onClick: ({ object }: any) => object && selected && drillWarehouse(selected, object),
    } as any)] : []),
    ...(warehouseMode && warehouseData ? [new PolygonLayer({
      id: 'pi-zones', data: warehouseData.zones,
      getPolygon: (z: WarehouseZone) => z.polygon, getElevation: (z: WarehouseZone) => z.elevation,
      getFillColor: (z: WarehouseZone) => {
        const base = z.color;
        return z.id === selectedZone ? [Math.min(255, base[0]+60), Math.min(255, base[1]+60), Math.min(255, base[2]+60), 230] : base;
      },
      getLineColor: [255, 255, 255, 80] as any, lineWidthMinPixels: 1,
      extruded: true, wireframe: true, pickable: true,
      onClick: ({ object }: any) => object && setSelectedZone((p: string | null) => p === object.id ? null : object.id),
    } as any), new TextLayer({
      id: 'pi-zone-labels', data: warehouseData.zones,
      getPosition: (z: WarehouseZone) => {
        const c = z.polygon; const lon = c.reduce((s, p) => s + p[0], 0) / c.length; const lat = c.reduce((s, p) => s + p[1], 0) / c.length;
        return [lon, lat, z.elevation];
      },
      getText: (z: WarehouseZone) => z.name + (z.targetTemp != null ? `\n${z.temperature}°C` : ''),
      getSize: 9, getColor: [255, 255, 255, 200] as any,
      getTextAnchor: 'middle' as any, getAlignmentBaseline: 'center' as any,
      background: true, getBackgroundColor: (z: WarehouseZone) => { const b = z.color; return [Math.floor(b[0]*.3), Math.floor(b[1]*.3), Math.floor(b[2]*.3), 170]; },
      backgroundPadding: [3, 1, 3, 1], billboard: true,
    } as any), new ScatterplotLayer({
      id: 'pi-sensors', data: warehouseData.sensors,
      getPosition: (s: WarehouseSensor) => [...s.position, 0.5] as any,
      getFillColor: (s: WarehouseSensor) => (s.status === 'critical' ? [239,68,68,255] : s.status === 'warning' ? [249,115,22,255] : [34,197,94,255]),
      getRadius: 2, radiusMinPixels: 7, radiusMaxPixels: 12,
      getLineColor: [255,255,255,200] as any, lineWidthMinPixels: 2, stroked: true, pickable: true,
    } as any)] : []),
  // eslint-disable-next-line react-hooks/exhaustive-deps
  ], [plants, selected, building, warehouseMode, warehouseData, selectedZone]);

  return (
    <div style={{ width: '100%', height: '100%', position: 'relative', background: '#0f1117', borderRadius: 8, overflow: 'hidden' }}>
      <DeckGL
        viewState={viewState}
        onViewStateChange={({ viewState: vs }: any) => setViewState(vs)}
        controller layers={layers}
        getTooltip={({ object }: any) => {
          if (!object) return null;
          if (object.PLANT_NAME) {
            const s = Math.min(4, object.MAX_SEVERITY ?? 0);
            return { html: `<div style="font-size:12px;padding:5px 9px"><b>${object.PLANT_NAME}</b><br/>${object.CITY}, ${object.COUNTRY}<br/><span style="color:${SEVERITY_HEX[s]}">${SEVERITY_LABELS[s]}</span></div>` };
          }
          if (object.properties?.is_plant_building) return { html: `<div style="font-size:12px;padding:5px 9px"><b>🏭 Plant Building</b><br/>${object.properties.area_sqm?.toLocaleString()} m²<br/><i>Click to enter warehouse</i></div>` };
          if (object.polygon) { const z = object as WarehouseZone; const c = z.alertStatus==='critical'?'#ef4444':z.alertStatus==='warning'?'#f97316':'#22c55e'; return { html: `<div style="font-size:12px;padding:5px 9px"><b>${z.name}</b><br/>${z.targetTemp!=null?`${z.temperature}°C · `:''}${z.alertStatus.toUpperCase()} <span style="color:${c}">●</span></div>` }; }
          if (object.zoneId) { const s = object as WarehouseSensor; return { html: `<div style="font-size:12px;padding:5px 9px"><b>${s.name}</b><br/><span style="color:${s.status==='critical'?'#ef4444':s.status==='warning'?'#f97316':'#22c55e'};font-weight:700">${s.value}${s.unit}</span>${s.alert?`<br/><span style="color:#f97316">⚠ ${s.alert}</span>`:''}</div>` }; }
          return null;
        }}
      />

      {/* Nav buttons */}
      {selected && !warehouseMode && (
        <button onClick={resetView} style={{ position: 'absolute', top: 10, left: 10, background: 'rgba(0,0,0,0.75)', color: '#fff', border: '1px solid rgba(255,255,255,0.2)', borderRadius: 6, padding: '5px 12px', cursor: 'pointer', fontSize: 12, backdropFilter: 'blur(6px)' }}>
          ← All Plants
        </button>
      )}
      {warehouseMode && (
        <>
          <button onClick={exitWarehouse} style={{ position: 'absolute', top: 10, left: 10, background: 'rgba(0,0,0,0.75)', color: '#fff', border: '1px solid rgba(255,255,255,0.2)', borderRadius: 6, padding: '5px 12px', cursor: 'pointer', fontSize: 12 }}>
            ← Plant
          </button>
          <div style={{ position: 'absolute', top: 10, left: '50%', transform: 'translateX(-50%)', background: 'rgba(0,0,0,0.75)', color: '#fff', padding: '5px 14px', borderRadius: 6, fontSize: 12, fontWeight: 600, backdropFilter: 'blur(6px)', whiteSpace: 'nowrap' }}>
            🏭 {selected?.PLANT_NAME}
          </div>
        </>
      )}

      {/* Selected zone badge */}
      {selectedZone && warehouseData && (
        <div style={{ position: 'absolute', bottom: 10, left: '50%', transform: 'translateX(-50%)', background: 'rgba(0,0,0,0.85)', color: '#fff', padding: '6px 14px', borderRadius: 6, fontSize: 12, maxWidth: 280, textAlign: 'center' }}>
          {(() => {
            const z = warehouseData.zones.find(x => x.id === selectedZone);
            if (!z) return null;
            const c = z.alertStatus === 'critical' ? '#ef4444' : z.alertStatus === 'warning' ? '#f97316' : '#22c55e';
            return <><b style={{ color: c }}>{z.name}</b>{z.targetTemp != null && ` · ${z.temperature}°C`} · Humidity {z.humidity}%</>;
          })()}
        </div>
      )}

      {/* Hint */}
      {selected && !warehouseMode && building && !loading && (
        <div style={{ position: 'absolute', bottom: 10, left: '50%', transform: 'translateX(-50%)', background: 'rgba(41,181,232,0.85)', color: '#fff', padding: '5px 14px', borderRadius: 14, fontSize: 12, fontWeight: 600, pointerEvents: 'none', whiteSpace: 'nowrap' }}>
          Click building → warehouse view
        </div>
      )}

      {loading && (
        <div style={{ position: 'absolute', top: '50%', left: '50%', transform: 'translate(-50%,-50%)', background: 'rgba(0,0,0,0.8)', color: '#fff', padding: '10px 20px', borderRadius: 8, fontSize: 13 }}>
          {warehouseMode ? 'Building floor plan…' : 'Loading…'}
        </div>
      )}

      {/* Plant list overlay when world view */}
      {!selected && plants.length > 0 && (
        <div style={{ position: 'absolute', top: 10, right: 10, background: 'rgba(0,0,0,0.75)', backdropFilter: 'blur(6px)', borderRadius: 8, padding: '8px 12px', minWidth: 160 }}>
          <div style={{ fontSize: 11, color: '#888', marginBottom: 6, fontWeight: 600, textTransform: 'uppercase', letterSpacing: 0.5 }}>Plants</div>
          {plants.map(p => {
            const s = Math.min(4, p.MAX_SEVERITY);
            return (
              <div key={p.PLANT_ID} onClick={() => selectPlant(p)} style={{ display: 'flex', alignItems: 'center', gap: 7, padding: '3px 0', cursor: 'pointer' }}>
                <div style={{ width: 8, height: 8, borderRadius: '50%', background: SEVERITY_HEX[s], flexShrink: 0 }} />
                <span style={{ fontSize: 12, color: '#ddd' }}>{p.PLANT_NAME}</span>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

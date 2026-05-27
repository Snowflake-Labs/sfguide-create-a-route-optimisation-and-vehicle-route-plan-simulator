import { useState, useCallback, useEffect, useMemo } from 'react';
import DeckGL from '@deck.gl/react';
import { ScatterplotLayer, GeoJsonLayer, TextLayer, PolygonLayer } from '@deck.gl/layers';
import { BitmapLayer } from '@deck.gl/layers';
import { TileLayer } from '@deck.gl/geo-layers';
import { AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Legend } from 'recharts';

const CARTO_LIGHT = '/api/tiles/{z}/{x}/{y}';
function cartoBasemap() {
  return new TileLayer({
    id: 'carto-basemap', data: CARTO_LIGHT, minZoom: 0, maxZoom: 19, tileSize: 256,
    renderSubLayers: (props: any) => {
      const { boundingBox } = props.tile;
      return new BitmapLayer(props, { data: undefined, image: props.data, bounds: [boundingBox[0][0], boundingBox[0][1], boundingBox[1][0], boundingBox[1][1]] });
    }
  });
}

const SEVERITY_COLORS: [number, number, number, number][] = [
  [34,  197, 94,  220],
  [234, 179, 8,   220],
  [249, 115, 22,  220],
  [239, 68,  68,  220],
  [185, 28,  28,  220],
];
const SEVERITY_LABELS = ['No Alerts', 'Low', 'Moderate', 'High', 'Critical'];
const SEVERITY_HEX    = ['#22c55e', '#eab308', '#f97316', '#ef4444', '#b91c1c'];
const WORLD_VIEW = { longitude: 20, latitude: 25, zoom: 1.4, pitch: 0, bearing: 0 };

interface PlantStatus {
  PLANT_ID: number; PLANT_NAME: string; PLANT_CODE: string;
  CITY: string; COUNTRY: string; REGION: string;
  SPECIALISATION: string; CAPACITY_BATCHES_MONTH: number;
  LATITUDE: number; LONGITUDE: number;
  MAX_SEVERITY: number; BATCH_SEVERITY: number; TEMP_SEVERITY: number;
  STOCK_SEVERITY: number; SHIPMENT_SEVERITY: number;
  CRITICAL_BATCHES: number; TEMP_EXCURSIONS: number;
  CRITICAL_STOCK_ITEMS: number; DELAYED_SHIPMENTS: number;
  BATCHES_IN_PROGRESS: number;
}
interface BatchRow {
  BATCH_NUMBER: string; PRODUCT_NAME: string; BUSINESS_LINE: string;
  STATUS: string; QC_RESULT: string; YIELD_PCT: number;
  DEVIATION_COUNT: number; DEVIATION_SEVERITY: string;
  PLANNED_COMPLETE: string; COST_USD_M: number;
}
interface InventoryRow {
  PRODUCT_NAME: string; BUSINESS_LINE: string;
  MATERIAL_TYPE: string; STOCK_KG: number; SAFETY_STOCK_KG: number;
  DAYS_OF_COVERAGE: number; STOCK_STATUS: string;
  TEMP_EXCURSION_FLAG: boolean; EXPIRY_DATE: string;
}
interface WarehouseZone {
  id: string; name: string; type: string;
  polygon: [number, number][];
  elevation: number;
  alertStatus: 'critical' | 'warning' | 'ok';
  temperature: number; targetTemp: number | null;
  humidity: number;
  color: [number, number, number, number];
  inventory: { name: string; expiryDate: string; daysLeft: number; status: string }[];
}
interface WarehouseSensor {
  id: string; name: string; zoneId: string;
  position: [number, number];
  type: string; value: number; unit: string;
  status: 'critical' | 'warning' | 'ok';
  alert: string | null;
}
interface WarehouseData {
  zones: WarehouseZone[];
  sensors: WarehouseSensor[];
  sensorTimeline: Record<string, any>[];
  areaSqm: number;
}

export default function PlantIntelligence() {
  const [plants, setPlants]           = useState<PlantStatus[]>([]);
  const [selected, setSelected]       = useState<PlantStatus | null>(null);
  const [buildings, setBuildings]     = useState<any>(null);
  const [batches, setBatches]         = useState<BatchRow[]>([]);
  const [inventory, setInventory]     = useState<InventoryRow[]>([]);
  const [activeTab, setActiveTab]     = useState<'batches' | 'inventory'>('batches');
  const [loadingBuildings, setLoadingBuildings] = useState(false);
  const [viewState, setViewState]     = useState<any>(WORLD_VIEW);

  // Warehouse drill-down state
  const [warehouseMode, setWarehouseMode]   = useState(false);
  const [warehouseData, setWarehouseData]   = useState<WarehouseData | null>(null);
  const [selectedZone, setSelectedZone]     = useState<string | null>(null);
  const [loadingWarehouse, setLoadingWarehouse] = useState(false);
  const [warehouseTab, setWarehouseTab]     = useState<'zones' | 'sensors' | 'timeline'>('zones');

  useEffect(() => {
    fetch('/api/plant-intel/plants')
      .then(r => r.json())
      .then((data: any) => setPlants(Array.isArray(data) ? data.map((r: any) => ({
        ...r,
        LATITUDE:               Number(r.LATITUDE),
        LONGITUDE:              Number(r.LONGITUDE),
        PLANT_ID:               Number(r.PLANT_ID),
        CAPACITY_BATCHES_MONTH: Number(r.CAPACITY_BATCHES_MONTH ?? 0),
        MAX_SEVERITY:           Number(r.MAX_SEVERITY ?? 0),
        BATCH_SEVERITY:         Number(r.BATCH_SEVERITY ?? 0),
        TEMP_SEVERITY:          Number(r.TEMP_SEVERITY ?? 0),
        STOCK_SEVERITY:         Number(r.STOCK_SEVERITY ?? 0),
        SHIPMENT_SEVERITY:      Number(r.SHIPMENT_SEVERITY ?? 0),
        CRITICAL_BATCHES:       Number(r.CRITICAL_BATCHES ?? 0),
        TEMP_EXCURSIONS:        Number(r.TEMP_EXCURSIONS ?? 0),
        CRITICAL_STOCK_ITEMS:   Number(r.CRITICAL_STOCK_ITEMS ?? 0),
        DELAYED_SHIPMENTS:      Number(r.DELAYED_SHIPMENTS ?? 0),
        BATCHES_IN_PROGRESS:    Number(r.BATCHES_IN_PROGRESS ?? 0),
      })) : []))
      .catch(console.error);
  }, []);

  const selectPlant = useCallback(async (plant: PlantStatus) => {
    setSelected(plant);
    setBuildings(null);
    setBatches([]);
    setInventory([]);
    setWarehouseMode(false);
    setWarehouseData(null);
    setSelectedZone(null);
    setActiveTab('batches');
    setViewState({ longitude: plant.LONGITUDE, latitude: plant.LATITUDE, zoom: 15, pitch: 45, bearing: -15, transitionDuration: 1200 });

    setLoadingBuildings(true);
    try {
      const [bldResp, batchResp, invResp] = await Promise.all([
        fetch(`/api/plant-intel/buildings?plant_id=${plant.PLANT_ID}`).then(r => r.json()),
        fetch(`/api/plant-intel/batches?plant_id=${plant.PLANT_ID}`).then(r => r.json()),
        fetch(`/api/plant-intel/inventory?plant_id=${plant.PLANT_ID}`).then(r => r.json()),
      ]);
      setBuildings(bldResp);
      setBatches(Array.isArray(batchResp) ? batchResp : []);
      setInventory(Array.isArray(invResp) ? invResp : []);
    } catch (e) { console.error(e); }
    setLoadingBuildings(false);
  }, []);

  const drillIntoWarehouse = useCallback(async (plant: PlantStatus, buildingFeature: any) => {
    // Zoom into the building centroid at very high zoom
    const coords: [number, number][] = [];
    const extract = (c: any) => { if (typeof c[0] === 'number') coords.push(c as [number, number]); else c.forEach(extract); };
    try { extract(buildingFeature.geometry?.coordinates || []); } catch {}
    if (coords.length > 0) {
      const lon = coords.reduce((s, c) => s + c[0], 0) / coords.length;
      const lat = coords.reduce((s, c) => s + c[1], 0) / coords.length;
      setViewState({ longitude: lon, latitude: lat, zoom: 19, pitch: 60, bearing: -20, transitionDuration: 1500 });
    }

    setLoadingWarehouse(true);
    try {
      const data = await fetch(`/api/plant-intel/warehouse?plant_id=${plant.PLANT_ID}`).then(r => r.json());
      setWarehouseData(data);
      setWarehouseMode(true);
      setWarehouseTab('zones');
      setSelectedZone(null);
    } catch (e) { console.error(e); }
    setLoadingWarehouse(false);
  }, []);

  const resetView = useCallback(() => {
    setSelected(null); setBuildings(null); setBatches([]); setInventory([]);
    setWarehouseMode(false); setWarehouseData(null); setSelectedZone(null);
    setViewState({ ...WORLD_VIEW, transitionDuration: 800 });
  }, []);

  const exitWarehouse = useCallback(() => {
    if (!selected) return;
    setWarehouseMode(false);
    setWarehouseData(null);
    setSelectedZone(null);
    setViewState({ longitude: selected.LONGITUDE, latitude: selected.LATITUDE, zoom: 15, pitch: 45, bearing: -15, transitionDuration: 800 });
  }, [selected]);

  const severity = selected ? Math.min(4, Math.max(0, selected.MAX_SEVERITY ?? 0)) : 0;
  const buildingFillColor: [number, number, number, number] = [41, 181, 232, 200];

  // Sensor status colors
  const sensorColor = (status: string): [number, number, number, number] =>
    status === 'critical' ? [239, 68, 68, 255] : status === 'warning' ? [249, 115, 22, 255] : [34, 197, 94, 255];

  const layers: any[] = useMemo(() => [
    cartoBasemap(),

    // Plant markers
    new ScatterplotLayer<PlantStatus>({
      id: 'plants-scatter',
      data: plants,
      getPosition: (d: PlantStatus) => [d.LONGITUDE, d.LATITUDE],
      getRadius: (d: PlantStatus) => Math.sqrt(d.CAPACITY_BATCHES_MONTH) * 8000,
      radiusMinPixels: selected ? 6 : 22,
      radiusMaxPixels: selected ? 40 : 60,
      getFillColor: (d: PlantStatus) => SEVERITY_COLORS[Math.min(4, d.MAX_SEVERITY ?? 0)] as any,
      getLineColor: [255, 255, 255, 220] as any,
      lineWidthMinPixels: 2,
      stroked: true,
      pickable: true,
      onClick: ({ object }: any) => object && selectPlant(object),
    } as any),

    ...(!selected ? [new TextLayer<PlantStatus>({
      id: 'plant-labels',
      data: plants,
      getPosition: (d: PlantStatus) => [d.LONGITUDE, d.LATITUDE],
      getPixelOffset: [0, 26] as any,
      getText: (d: PlantStatus) => d.PLANT_CODE,
      getSize: 12,
      getColor: [255, 255, 255, 255] as any,
      background: true,
      getBackgroundColor: ((d: PlantStatus) => { const c = SEVERITY_COLORS[Math.min(4, d.MAX_SEVERITY ?? 0)]; return [c[0], c[1], c[2], 210]; }) as any,
      backgroundPadding: [6, 3, 6, 3],
      fontFamily: 'monospace', fontWeight: 'bold' as any,
      getAlignmentBaseline: 'top', getTextAnchor: 'middle',
      pickable: true,
      onClick: ({ object }: any) => object && selectPlant(object),
    } as any)] : []),

    // Primary building — shown when plant is selected and NOT in warehouse mode
    ...(selected && buildings && !warehouseMode ? [new GeoJsonLayer({
      id: 'plant-building-primary',
      data: buildings,
      filled: true, extruded: true, wireframe: true,
      getFillColor: buildingFillColor as any,
      getLineColor: [255, 255, 255, 200] as any,
      lineWidthMinPixels: 2,
      getElevation: (f: any) => (f.properties?.height ? Number(f.properties.height) * 1.5 : 15),
      elevationScale: 1,
      pickable: true,
      onClick: ({ object }: any) => object && selected && drillIntoWarehouse(selected, object),
    } as any)] : []),

    // Warehouse zones — 3D extruded polygons
    ...(warehouseMode && warehouseData ? [new PolygonLayer({
      id: 'warehouse-zones',
      data: warehouseData.zones,
      getPolygon: (z: WarehouseZone) => z.polygon,
      getElevation: (z: WarehouseZone) => z.elevation,
      getFillColor: (z: WarehouseZone) => {
        const base = z.color;
        const isSelected = z.id === selectedZone;
        return isSelected ? [Math.min(255, base[0] + 60), Math.min(255, base[1] + 60), Math.min(255, base[2] + 60), 230] : base;
      },
      getLineColor: [255, 255, 255, 80] as any,
      lineWidthMinPixels: 1,
      extruded: true,
      wireframe: true,
      pickable: true,
      onClick: ({ object }: any) => object && setSelectedZone((prev: string | null) => prev === object.id ? null : object.id),
    } as any)] : []),

    // Zone labels
    ...(warehouseMode && warehouseData ? [new TextLayer({
      id: 'zone-labels',
      data: warehouseData.zones,
      getPosition: (z: WarehouseZone) => {
        const c = z.polygon;
        const lon = c.reduce((s, p) => s + p[0], 0) / c.length;
        const lat = c.reduce((s, p) => s + p[1], 0) / c.length;
        return [lon, lat, z.elevation];
      },
      getText: (z: WarehouseZone) => `${z.name}\n${z.targetTemp != null ? `${z.temperature}°C` : ''}`,
      getSize: 10,
      getColor: [255, 255, 255, 230] as any,
      getTextAnchor: 'middle' as any,
      getAlignmentBaseline: 'center' as any,
      fontFamily: 'monospace',
      background: true,
      getBackgroundColor: (z: WarehouseZone) => {
        const base = z.color;
        return [Math.floor(base[0] * 0.3), Math.floor(base[1] * 0.3), Math.floor(base[2] * 0.3), 180];
      },
      backgroundPadding: [4, 2, 4, 2],
      billboard: true,
    } as any)] : []),

    // Sensor markers
    ...(warehouseMode && warehouseData ? [new ScatterplotLayer({
      id: 'sensors',
      data: warehouseData.sensors,
      getPosition: (s: WarehouseSensor) => [...s.position, 0.5] as any,
      getFillColor: (s: WarehouseSensor) => sensorColor(s.status),
      getRadius: 2,
      radiusMinPixels: 8,
      radiusMaxPixels: 14,
      getLineColor: [255, 255, 255, 200] as any,
      lineWidthMinPixels: 2,
      stroked: true,
      pickable: true,
    } as any)] : []),
  // eslint-disable-next-line react-hooks/exhaustive-deps
  ], [plants, selected, buildings, warehouseMode, warehouseData, selectedZone]);

  function AlertBadge({ label, count, color }: { label: string; count: number; color: string }) {
    if (count === 0) return null;
    return (
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '4px 10px', borderRadius: 6, background: color + '22', border: `1px solid ${color}55`, marginBottom: 4 }}>
        <span style={{ color, fontWeight: 700, fontSize: 18 }}>{count}</span>
        <span style={{ color: 'var(--text)', fontSize: 12 }}>{label}</span>
      </div>
    );
  }

  function StatusBadge({ label, status }: { label: string; status: string }) {
    const c = status === 'critical' ? '#ef4444' : status === 'warning' ? '#f97316' : '#22c55e';
    return <span style={{ background: c + '22', color: c, border: `1px solid ${c}55`, borderRadius: 4, padding: '2px 6px', fontSize: 11, fontWeight: 600 }}>{label}</span>;
  }

  const selZoneData = selectedZone ? warehouseData?.zones.find(z => z.id === selectedZone) : null;
  const zoneSensors = selZoneData ? warehouseData?.sensors.filter(s => s.zoneId === selectedZone) : [];

  return (
    <div style={{ display: 'flex', height: '100%', background: 'var(--bg, #0f1117)' }}>
      {/* MAP */}
      <div style={{ flex: 1, position: 'relative' }}>
        <DeckGL
          viewState={viewState}
          onViewStateChange={({ viewState: vs }: any) => setViewState(vs)}
          controller
          layers={layers}
          getTooltip={({ object }: any) => {
            if (!object) return null;
            if (object.PLANT_NAME) {
              const s = Math.min(4, object.MAX_SEVERITY ?? 0);
              return { html: `<div style="font-size:13px;padding:6px 10px"><b>${object.PLANT_NAME}</b><br/>${object.CITY}, ${object.COUNTRY}<br/><span style="color:${SEVERITY_HEX[s]}">${SEVERITY_LABELS[s]}</span></div>` };
            }
            if (object.polygon) {
              const z = object as WarehouseZone;
              const alertColor = z.alertStatus === 'critical' ? '#ef4444' : z.alertStatus === 'warning' ? '#f97316' : '#22c55e';
              return { html: `<div style="font-size:12px;padding:6px 10px"><b>${z.name}</b><br/>${z.targetTemp != null ? `Temp: ${z.temperature}°C (target ${z.targetTemp}°C)<br/>` : ''}Humidity: ${z.humidity}%<br/><span style="color:${alertColor}">${z.alertStatus.toUpperCase()}</span><br/><i>Click to inspect</i></div>` };
            }
            if (object.properties?.is_plant_building) {
              return { html: `<div style="font-size:12px;padding:6px 10px"><b>🏭 Plant Building</b><br/>Area: ${object.properties.area_sqm?.toLocaleString()} m²<br/><i>Click to enter warehouse view</i></div>` };
            }
            if (object.zoneId) {
              const s = object as WarehouseSensor;
              const c = s.status === 'critical' ? '#ef4444' : s.status === 'warning' ? '#f97316' : '#22c55e';
              return { html: `<div style="font-size:12px;padding:6px 10px"><b>${s.name}</b><br/>Value: <span style="color:${c};font-weight:700">${s.value}${s.unit}</span><br/>${s.alert ? `<span style="color:${c}">⚠ ${s.alert}</span>` : '<span style="color:#22c55e">✓ Normal</span>'}</div>` };
            }
            return null;
          }}
        />

        {/* Navigation buttons */}
        {selected && !warehouseMode && (
          <button onClick={resetView} style={{ position: 'absolute', top: 12, left: 12, background: 'rgba(0,0,0,0.75)', color: '#fff', border: '1px solid rgba(255,255,255,0.2)', borderRadius: 8, padding: '6px 14px', cursor: 'pointer', fontSize: 13, backdropFilter: 'blur(8px)' }}>
            ← All Plants
          </button>
        )}
        {warehouseMode && (
          <>
            <button onClick={exitWarehouse} style={{ position: 'absolute', top: 12, left: 12, background: 'rgba(0,0,0,0.75)', color: '#fff', border: '1px solid rgba(255,255,255,0.2)', borderRadius: 8, padding: '6px 14px', cursor: 'pointer', fontSize: 13, backdropFilter: 'blur(8px)' }}>
              ← Plant View
            </button>
            <div style={{ position: 'absolute', top: 12, left: '50%', transform: 'translateX(-50%)', background: 'rgba(0,0,0,0.75)', color: '#fff', padding: '6px 16px', borderRadius: 8, fontSize: 13, fontWeight: 600, backdropFilter: 'blur(8px)' }}>
              🏭 {selected?.PLANT_NAME} — Warehouse Interior
            </div>
          </>
        )}

        {(loadingBuildings || loadingWarehouse) && (
          <div style={{ position: 'absolute', top: '50%', left: '50%', transform: 'translate(-50%,-50%)', background: 'rgba(0,0,0,0.85)', color: '#fff', padding: '14px 28px', borderRadius: 10, fontSize: 14 }}>
            {loadingWarehouse ? 'Generating warehouse floor plan…' : 'Loading plant building…'}
          </div>
        )}

        {/* Hint: click building */}
        {selected && !warehouseMode && buildings && !loadingBuildings && (
          <div style={{ position: 'absolute', bottom: 16, left: '50%', transform: 'translateX(-50%)', background: 'rgba(41,181,232,0.9)', color: '#fff', padding: '6px 16px', borderRadius: 20, fontSize: 13, fontWeight: 600, pointerEvents: 'none' }}>
            Click the highlighted building to enter warehouse view
          </div>
        )}
      </div>

      {/* SIDEBAR */}
      <div style={{ width: 360, background: 'var(--surface, rgba(0,0,0,0.5))', borderLeft: '1px solid rgba(255,255,255,0.08)', display: 'flex', flexDirection: 'column', overflowY: 'auto', color: 'var(--text, #fff)' }}>

        {/* ─── World view: plant list ─── */}
        {!selected && (
          <>
            <div style={{ padding: '16px 20px', borderBottom: '1px solid rgba(255,255,255,0.08)' }}>
              <div style={{ fontWeight: 700, fontSize: 16, marginBottom: 4 }}>Manufacturing Plants</div>
              <div style={{ fontSize: 12, color: 'var(--text-muted, #888)' }}>Click a plant to view its primary building and enter the warehouse</div>
            </div>
            {plants.map(p => {
              const s = Math.min(4, p.MAX_SEVERITY ?? 0);
              return (
                <div key={p.PLANT_ID} onClick={() => selectPlant(p)} style={{ padding: '12px 20px', borderBottom: '1px solid rgba(255,255,255,0.06)', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 10 }}>
                  <div style={{ width: 10, height: 10, borderRadius: '50%', background: SEVERITY_HEX[s], flexShrink: 0 }} />
                  <div style={{ flex: 1 }}>
                    <div style={{ fontWeight: 600, fontSize: 14 }}>{p.PLANT_NAME}</div>
                    <div style={{ fontSize: 11, color: '#888' }}>{p.CITY}, {p.COUNTRY} · {p.PLANT_CODE}</div>
                  </div>
                  <span style={{ fontSize: 11, color: SEVERITY_HEX[s], fontWeight: 600 }}>{SEVERITY_LABELS[s]}</span>
                </div>
              );
            })}
          </>
        )}

        {/* ─── Plant view: batches / inventory ─── */}
        {selected && !warehouseMode && (
          <>
            <div style={{ padding: '14px 20px', borderBottom: '1px solid rgba(255,255,255,0.08)' }}>
              <div style={{ fontWeight: 700, fontSize: 16 }}>{selected.PLANT_NAME}</div>
              <div style={{ fontSize: 11, color: '#888' }}>{selected.CITY}, {selected.COUNTRY} · {selected.PLANT_CODE}</div>
              <div style={{ display: 'flex', gap: 8, marginTop: 10, flexWrap: 'wrap' }}>
                {selected.CRITICAL_BATCHES > 0 && <AlertBadge label="Critical Batches" count={selected.CRITICAL_BATCHES} color="#ef4444" />}
                {selected.TEMP_EXCURSIONS > 0 && <AlertBadge label="Temp Excursions" count={selected.TEMP_EXCURSIONS} color="#f97316" />}
                {selected.CRITICAL_STOCK_ITEMS > 0 && <AlertBadge label="Critical Stock" count={selected.CRITICAL_STOCK_ITEMS} color="#eab308" />}
                {selected.DELAYED_SHIPMENTS > 0 && <AlertBadge label="Delayed Shipments" count={selected.DELAYED_SHIPMENTS} color="#64748b" />}
              </div>
            </div>
            <div style={{ display: 'flex', borderBottom: '1px solid rgba(255,255,255,0.08)' }}>
              {(['batches', 'inventory'] as const).map(t => (
                <button key={t} onClick={() => setActiveTab(t)} style={{ flex: 1, padding: '10px 0', background: 'transparent', border: 'none', borderBottom: activeTab === t ? '2px solid #29b5e8' : '2px solid transparent', color: activeTab === t ? '#29b5e8' : '#888', cursor: 'pointer', fontSize: 12, fontWeight: activeTab === t ? 600 : 400 }}>
                  {t.charAt(0).toUpperCase() + t.slice(1)}
                </button>
              ))}
            </div>
            <div style={{ flex: 1, overflowY: 'auto' }}>
              {activeTab === 'batches' ? batches.map((b, i) => {
                const c = b.STATUS === 'ON_HOLD' || b.STATUS === 'REJECTED' ? '#ef4444' : b.STATUS === 'QC_REVIEW' ? '#f97316' : b.STATUS === 'IN_PROGRESS' ? '#3b82f6' : '#22c55e';
                return (
                  <div key={i} style={{ padding: '10px 20px', borderBottom: '1px solid rgba(255,255,255,0.05)' }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 }}>
                      <span style={{ fontWeight: 600, fontSize: 13 }}>{b.BATCH_NUMBER}</span>
                      <span style={{ background: c + '22', color: c, border: `1px solid ${c}55`, borderRadius: 4, padding: '2px 6px', fontSize: 11, fontWeight: 600 }}>{b.STATUS}</span>
                    </div>
                    <div style={{ fontSize: 12, color: '#aaa' }}>{b.PRODUCT_NAME}</div>
                    <div style={{ fontSize: 11, color: '#666', marginTop: 3 }}>Yield: {b.YIELD_PCT ?? '--'}% · Due: {b.PLANNED_COMPLETE ?? '--'}</div>
                  </div>
                );
              }) : inventory.map((inv, i) => {
                const c = inv.STOCK_STATUS === 'CRITICAL' ? '#ef4444' : inv.STOCK_STATUS === 'LOW' ? '#f97316' : '#22c55e';
                return (
                  <div key={i} style={{ padding: '10px 20px', borderBottom: '1px solid rgba(255,255,255,0.05)' }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 3 }}>
                      <span style={{ fontWeight: 600, fontSize: 13 }}>{inv.PRODUCT_NAME}</span>
                      <span style={{ background: c + '22', color: c, border: `1px solid ${c}55`, borderRadius: 4, padding: '2px 5px', fontSize: 11 }}>{inv.STOCK_STATUS}</span>
                    </div>
                    <div style={{ fontSize: 11, color: '#888' }}>{inv.MATERIAL_TYPE} · {inv.DAYS_OF_COVERAGE ?? '--'}d coverage</div>
                    {inv.TEMP_EXCURSION_FLAG && <div style={{ fontSize: 11, color: '#f97316', marginTop: 2 }}>⚠ Temperature excursion</div>}
                  </div>
                );
              })}
            </div>
          </>
        )}

        {/* ─── Warehouse view ─── */}
        {selected && warehouseMode && warehouseData && (
          <>
            <div style={{ padding: '14px 20px', borderBottom: '1px solid rgba(255,255,255,0.08)' }}>
              <div style={{ fontWeight: 700, fontSize: 16 }}>🏭 Warehouse Interior</div>
              <div style={{ fontSize: 11, color: '#888', marginBottom: 8 }}>{selected.PLANT_NAME} · {Math.round(warehouseData.areaSqm).toLocaleString()} m²</div>
              <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                {(['zones', 'sensors', 'timeline'] as const).map(t => (
                  <button key={t} onClick={() => setWarehouseTab(t)} style={{ padding: '4px 12px', borderRadius: 14, border: 'none', background: warehouseTab === t ? '#29b5e8' : 'rgba(255,255,255,0.1)', color: warehouseTab === t ? '#fff' : '#aaa', cursor: 'pointer', fontSize: 12, fontWeight: warehouseTab === t ? 600 : 400 }}>
                    {t.charAt(0).toUpperCase() + t.slice(1)}
                  </button>
                ))}
              </div>
            </div>

            <div style={{ flex: 1, overflowY: 'auto' }}>

              {/* ZONES tab */}
              {warehouseTab === 'zones' && (
                <>
                  {selZoneData ? (
                    <div style={{ padding: 16 }}>
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
                        <div style={{ fontWeight: 700, fontSize: 15 }}>{selZoneData.name}</div>
                        <StatusBadge label={selZoneData.alertStatus.toUpperCase()} status={selZoneData.alertStatus} />
                      </div>
                      <div style={{ display: 'flex', gap: 16, marginBottom: 12 }}>
                        {selZoneData.targetTemp != null && (
                          <div style={{ background: 'rgba(255,255,255,0.06)', borderRadius: 8, padding: '8px 12px', flex: 1 }}>
                            <div style={{ fontSize: 10, color: '#888', marginBottom: 2 }}>TEMPERATURE</div>
                            <div style={{ fontSize: 22, fontWeight: 700, color: selZoneData.alertStatus === 'critical' ? '#ef4444' : selZoneData.alertStatus === 'warning' ? '#f97316' : '#22c55e' }}>{selZoneData.temperature}°C</div>
                            <div style={{ fontSize: 10, color: '#888' }}>Target: {selZoneData.targetTemp}°C</div>
                          </div>
                        )}
                        <div style={{ background: 'rgba(255,255,255,0.06)', borderRadius: 8, padding: '8px 12px', flex: 1 }}>
                          <div style={{ fontSize: 10, color: '#888', marginBottom: 2 }}>HUMIDITY</div>
                          <div style={{ fontSize: 22, fontWeight: 700, color: '#29b5e8' }}>{selZoneData.humidity}%</div>
                        </div>
                      </div>
                      {selZoneData.inventory.length > 0 && (
                        <>
                          <div style={{ fontSize: 11, color: '#888', marginBottom: 8, fontWeight: 600, textTransform: 'uppercase', letterSpacing: 0.5 }}>Inventory</div>
                          {selZoneData.inventory.map((item, i) => (
                            <div key={i} style={{ padding: '7px 10px', marginBottom: 6, borderRadius: 6, background: 'rgba(255,255,255,0.04)', border: `1px solid ${item.status === 'critical' ? '#ef444433' : item.status === 'warning' ? '#f9731633' : 'rgba(255,255,255,0.08)'}` }}>
                              <div style={{ fontSize: 13, fontWeight: 600 }}>{item.name}</div>
                              <div style={{ fontSize: 11, marginTop: 3, display: 'flex', justifyContent: 'space-between' }}>
                                <span style={{ color: '#888' }}>Expires: {item.expiryDate}</span>
                                <StatusBadge label={`${item.daysLeft}d`} status={item.status} />
                              </div>
                            </div>
                          ))}
                        </>
                      )}
                      {zoneSensors && zoneSensors.length > 0 && (
                        <>
                          <div style={{ fontSize: 11, color: '#888', marginTop: 12, marginBottom: 8, fontWeight: 600, textTransform: 'uppercase', letterSpacing: 0.5 }}>Sensors</div>
                          {zoneSensors.map((s: any) => (
                            <div key={s.id} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '6px 10px', marginBottom: 4, borderRadius: 6, background: 'rgba(255,255,255,0.04)' }}>
                              <div>
                                <div style={{ fontSize: 12, fontWeight: 600 }}>{s.name}</div>
                                {s.alert && <div style={{ fontSize: 11, color: '#f97316' }}>⚠ {s.alert}</div>}
                              </div>
                              <div style={{ textAlign: 'right' }}>
                                <div style={{ fontWeight: 700, color: s.status === 'critical' ? '#ef4444' : s.status === 'warning' ? '#f97316' : '#22c55e' }}>{s.value}{s.unit}</div>
                                <StatusBadge label={s.status} status={s.status} />
                              </div>
                            </div>
                          ))}
                        </>
                      )}
                      <button onClick={() => setSelectedZone(null)} style={{ marginTop: 12, width: '100%', padding: '8px', background: 'rgba(255,255,255,0.06)', border: '1px solid rgba(255,255,255,0.12)', borderRadius: 6, color: '#aaa', cursor: 'pointer', fontSize: 12 }}>
                        ← All Zones
                      </button>
                    </div>
                  ) : (
                    warehouseData.zones.map(z => (
                      <div key={z.id} onClick={() => setSelectedZone(z.id)} style={{ padding: '11px 20px', borderBottom: '1px solid rgba(255,255,255,0.05)', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 12 }}>
                        <div style={{ width: 12, height: 12, borderRadius: 3, background: `rgb(${z.color[0]},${z.color[1]},${z.color[2]})`, flexShrink: 0 }} />
                        <div style={{ flex: 1 }}>
                          <div style={{ fontWeight: 600, fontSize: 13 }}>{z.name}</div>
                          <div style={{ fontSize: 11, color: '#888', marginTop: 2 }}>
                            {z.targetTemp != null && `${z.temperature}°C · `}Humidity {z.humidity}%
                          </div>
                        </div>
                        <StatusBadge label={z.alertStatus} status={z.alertStatus} />
                      </div>
                    ))
                  )}
                </>
              )}

              {/* SENSORS tab */}
              {warehouseTab === 'sensors' && (
                <div style={{ padding: '8px 0' }}>
                  {warehouseData.sensors.map(s => (
                    <div key={s.id} style={{ padding: '9px 20px', borderBottom: '1px solid rgba(255,255,255,0.05)', display: 'flex', alignItems: 'center', gap: 10 }}>
                      <div style={{ width: 10, height: 10, borderRadius: '50%', background: s.status === 'critical' ? '#ef4444' : s.status === 'warning' ? '#f97316' : '#22c55e', flexShrink: 0 }} />
                      <div style={{ flex: 1 }}>
                        <div style={{ fontSize: 12, fontWeight: 600 }}>{s.name}</div>
                        {s.alert && <div style={{ fontSize: 11, color: '#f97316' }}>⚠ {s.alert}</div>}
                      </div>
                      <div style={{ fontWeight: 700, fontSize: 14, color: s.status === 'critical' ? '#ef4444' : s.status === 'warning' ? '#f97316' : '#22c55e' }}>
                        {s.value}{s.unit}
                      </div>
                    </div>
                  ))}
                </div>
              )}

              {/* TIMELINE tab */}
              {warehouseTab === 'timeline' && (
                <div style={{ padding: 16 }}>
                  <div style={{ fontWeight: 600, fontSize: 13, marginBottom: 10 }}>24-Hour Sensor Readings</div>
                  <div style={{ marginBottom: 20 }}>
                    <div style={{ fontSize: 11, color: '#888', marginBottom: 6 }}>Temperature (°C)</div>
                    <ResponsiveContainer width="100%" height={160}>
                      <AreaChart data={warehouseData.sensorTimeline} margin={{ top: 4, right: 4, left: -20, bottom: 0 }}>
                        <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.06)" />
                        <XAxis dataKey="hour" tick={{ fontSize: 9, fill: '#666' }} interval={5} />
                        <YAxis tick={{ fontSize: 9, fill: '#666' }} />
                        <Tooltip contentStyle={{ background: '#1a1a2e', border: '1px solid #333', fontSize: 11 }} />
                        <Legend wrapperStyle={{ fontSize: 10 }} />
                        <Area type="monotone" dataKey="Cold A (°C)" stroke="#3b82f6" fill="#3b82f620" strokeWidth={2} dot={false} />
                        <Area type="monotone" dataKey="Cold B (°C)" stroke="#06b6d4" fill="#06b6d420" strokeWidth={2} dot={false} />
                        <Area type="monotone" dataKey="Controlled (°C)" stroke="#8b5cf6" fill="#8b5cf620" strokeWidth={2} dot={false} />
                      </AreaChart>
                    </ResponsiveContainer>
                  </div>
                  <div>
                    <div style={{ fontSize: 11, color: '#888', marginBottom: 6 }}>Humidity & CO₂</div>
                    <ResponsiveContainer width="100%" height={140}>
                      <AreaChart data={warehouseData.sensorTimeline} margin={{ top: 4, right: 4, left: -20, bottom: 0 }}>
                        <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.06)" />
                        <XAxis dataKey="hour" tick={{ fontSize: 9, fill: '#666' }} interval={5} />
                        <YAxis tick={{ fontSize: 9, fill: '#666' }} />
                        <Tooltip contentStyle={{ background: '#1a1a2e', border: '1px solid #333', fontSize: 11 }} />
                        <Legend wrapperStyle={{ fontSize: 10 }} />
                        <Area type="monotone" dataKey="Humidity (%)" stroke="#22c55e" fill="#22c55e20" strokeWidth={2} dot={false} />
                      </AreaChart>
                    </ResponsiveContainer>
                  </div>
                </div>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}

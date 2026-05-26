import { useState, useEffect, useCallback } from 'react';
import DeckGL from '@deck.gl/react';
import { ScatterplotLayer, GeoJsonLayer, TextLayer } from '@deck.gl/layers';
import { BitmapLayer } from '@deck.gl/layers';
import { TileLayer } from '@deck.gl/geo-layers';

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
  [34,  197, 94,  220],  // 0 green   — no alerts
  [234, 179, 8,   220],  // 1 yellow  — low concern
  [249, 115, 22,  220],  // 2 amber   — delayed / low stock
  [239, 68,  68,  220],  // 3 red     — temp excursion / major deviation
  [185, 28,  28,  220],  // 4 crimson — critical hold / rejected
];

const SEVERITY_LABELS = ['No Alerts', 'Low', 'Moderate', 'High', 'Critical'];
const SEVERITY_HEX    = ['#22c55e',   '#eab308', '#f97316', '#ef4444', '#b91c1c'];

const WORLD_VIEW = { longitude: 5, latitude: 45, zoom: 2.5, pitch: 0, bearing: 0 };

interface PlantStatus {
  PLANT_ID: number; PLANT_NAME: string; PLANT_CODE: string;
  CITY: string; COUNTRY: string; REGION: string;
  SPECIALISATION: string; CAPACITY_BATCHES_MONTH: number;
  LATITUDE: number; LONGITUDE: number;
  MAX_SEVERITY: number;
  BATCH_SEVERITY: number; TEMP_SEVERITY: number;
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

export default function PlantIntelligence() {
  const [plants, setPlants]               = useState<PlantStatus[]>([]);
  const [selected, setSelected]           = useState<PlantStatus | null>(null);
  const [buildings, setBuildings]         = useState<any>(null);
  const [batches, setBatches]             = useState<BatchRow[]>([]);
  const [inventory, setInventory]         = useState<InventoryRow[]>([]);
  const [activeTab, setActiveTab]         = useState<'batches' | 'inventory'>('batches');
  const [loadingBuildings, setLoadingBuildings] = useState(false);
  const [viewState, setViewState]         = useState<any>(WORLD_VIEW);

  useEffect(() => {
    fetch('/api/plant-intel/plants')
      .then(r => r.json())
      .then((rows: PlantStatus[]) => setPlants(rows))
      .catch(console.error);
  }, []);

  const selectPlant = useCallback(async (plant: PlantStatus) => {
    setSelected(plant);
    setBuildings(null);
    setBatches([]);
    setInventory([]);
    setActiveTab('batches');
    setViewState({ longitude: plant.LONGITUDE, latitude: plant.LATITUDE, zoom: 16, pitch: 40, bearing: -15, transitionDuration: 1200 });

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

  const resetView = useCallback(() => {
    setSelected(null); setBuildings(null); setBatches([]); setInventory([]);
    setViewState({ ...WORLD_VIEW, transitionDuration: 800 });
  }, []);

  const severity = selected ? Math.min(4, Math.max(0, selected.MAX_SEVERITY ?? 0)) : 0;
  const fillColor = selected ? SEVERITY_COLORS[severity] : [100, 100, 100, 180];

  const layers: any[] = [
    cartoBasemap(),

    new ScatterplotLayer<PlantStatus>({
      id: 'plants-scatter',
      data: plants,
      getPosition: (d: PlantStatus) => [d.LONGITUDE, d.LATITUDE],
      getRadius: (d: PlantStatus) => Math.sqrt(d.CAPACITY_BATCHES_MONTH) * 8000,
      radiusMinPixels: selected ? 6 : 12,
      radiusMaxPixels: selected ? 30 : 60,
      getFillColor: (d: PlantStatus) => SEVERITY_COLORS[Math.min(4, d.MAX_SEVERITY ?? 0)] as any,
      getLineColor: [255, 255, 255, 200] as any,
      lineWidthMinPixels: 2,
      pickable: true,
      onClick: ({ object }: any) => object && selectPlant(object),
    } as any),

    ...(!selected ? [new TextLayer<PlantStatus>({
      id: 'plant-labels',
      data: plants,
      getPosition: (d: PlantStatus) => [d.LONGITUDE, d.LATITUDE - 0.4],
      getText: (d: PlantStatus) => d.PLANT_CODE,
      getSize: 13,
      getColor: [255, 255, 255, 230] as any,
      background: true,
      getBackgroundColor: [0, 0, 0, 120] as any,
      backgroundPadding: [4, 2, 4, 2],
      fontFamily: 'monospace',
      fontWeight: 600 as any,
    } as any)] : []),

    ...(selected && buildings ? [new GeoJsonLayer({
      id: 'plant-buildings',
      data: buildings,
      filled: true,
      extruded: true,
      wireframe: false,
      getFillColor: fillColor as any,
      getLineColor: [255, 255, 255, 180] as any,
      lineWidthMinPixels: 1,
      getElevation: (f: any) => {
        const h = f.properties?.height;
        return h ? Number(h) * 0.9 : (f.properties?.type === 'BUILDING_PART' ? 5 : 10);
      },
      elevationScale: 1,
      pickable: true,
    } as any)] : []),
  ];

  function AlertBadge({ label, count, color }: { label: string; count: number; color: string }) {
    if (count === 0) return null;
    return (
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '4px 10px', borderRadius: 6, background: color + '22', border: `1px solid ${color}55`, marginBottom: 4 }}>
        <span style={{ color, fontWeight: 700, fontSize: 18 }}>{count}</span>
        <span style={{ color: 'var(--text)', fontSize: 12 }}>{label}</span>
      </div>
    );
  }

  function BatchStatusBadge({ status, severity }: { status: string; severity: string }) {
    const c = status === 'ON_HOLD' || status === 'REJECTED' ? '#ef4444'
            : status === 'QC_REVIEW' ? '#f97316'
            : status === 'IN_PROGRESS' ? '#3b82f6'
            : '#22c55e';
    return <span style={{ background: c + '22', color: c, border: `1px solid ${c}55`, borderRadius: 4, padding: '2px 6px', fontSize: 11, fontWeight: 600 }}>{status}</span>;
  }

  return (
    <div style={{ display: 'flex', height: '100%', background: 'var(--bg, #0f1117)' }}>
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
            if (object.properties) {
              return { html: `<div style="font-size:12px;padding:4px 8px">${object.properties.name || object.properties.class || 'Building'}<br/>${object.properties.height ? `${object.properties.height}m` : ''}</div>` };
            }
            return null;
          }}
        />
        {selected && (
          <button onClick={resetView} style={{ position: 'absolute', top: 12, left: 12, background: 'rgba(0,0,0,0.7)', color: '#fff', border: '1px solid rgba(255,255,255,0.2)', borderRadius: 8, padding: '6px 14px', cursor: 'pointer', fontSize: 13, backdropFilter: 'blur(8px)' }}>
            ← All Plants
          </button>
        )}
        {loadingBuildings && (
          <div style={{ position: 'absolute', top: '50%', left: '50%', transform: 'translate(-50%,-50%)', background: 'rgba(0,0,0,0.8)', color: '#fff', padding: '12px 24px', borderRadius: 8, fontSize: 14 }}>
            Loading building footprints…
          </div>
        )}
      </div>

      <div style={{ width: 340, background: 'var(--surface, rgba(0,0,0,0.4))', borderLeft: '1px solid rgba(255,255,255,0.08)', display: 'flex', flexDirection: 'column', overflowY: 'auto' }}>
        {!selected ? (
          <>
            <div style={{ padding: '16px 20px', borderBottom: '1px solid rgba(255,255,255,0.08)' }}>
              <div style={{ fontWeight: 700, fontSize: 16, marginBottom: 4 }}>Manufacturing Plants</div>
              <div style={{ fontSize: 12, color: 'var(--text-muted, #888)' }}>Click a plant on the map to zoom in and view building footprints and supply chain alerts</div>
            </div>
            {plants.map(p => {
              const s = Math.min(4, p.MAX_SEVERITY ?? 0);
              return (
                <div key={p.PLANT_ID} onClick={() => selectPlant(p)} style={{ padding: '12px 20px', borderBottom: '1px solid rgba(255,255,255,0.06)', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 10 }}>
                  <div style={{ width: 12, height: 12, borderRadius: '50%', background: SEVERITY_HEX[s], flexShrink: 0 }} />
                  <div style={{ flex: 1 }}>
                    <div style={{ fontWeight: 600, fontSize: 13 }}>{p.PLANT_NAME}</div>
                    <div style={{ fontSize: 11, color: 'var(--text-muted, #888)' }}>{p.CITY}, {p.COUNTRY} · {p.SPECIALISATION.replace(/_/g, ' ')}</div>
                  </div>
                  <div style={{ fontSize: 11, color: SEVERITY_HEX[s], fontWeight: 600 }}>{SEVERITY_LABELS[s]}</div>
                </div>
              );
            })}
            <div style={{ padding: '12px 20px', marginTop: 8 }}>
              <div style={{ fontSize: 11, color: 'var(--text-muted, #888)', marginBottom: 8 }}>Alert Legend</div>
              {SEVERITY_LABELS.map((label, i) => (
                <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
                  <div style={{ width: 10, height: 10, borderRadius: '50%', background: SEVERITY_HEX[i] }} />
                  <span style={{ fontSize: 11, color: 'var(--text-muted, #888)' }}>{label}</span>
                </div>
              ))}
            </div>
          </>
        ) : (
          <>
            <div style={{ padding: '16px 20px', borderBottom: '1px solid rgba(255,255,255,0.08)' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 8 }}>
                <div style={{ width: 14, height: 14, borderRadius: '50%', background: SEVERITY_HEX[severity], flexShrink: 0 }} />
                <div style={{ fontWeight: 700, fontSize: 16 }}>{selected.PLANT_NAME}</div>
              </div>
              <div style={{ fontSize: 12, color: 'var(--text-muted, #888)', marginBottom: 12 }}>{selected.CITY}, {selected.COUNTRY} · {selected.SPECIALISATION.replace(/_/g, ' ')}</div>
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 4 }}>
                <AlertBadge label="Batches On Hold / Rejected" count={selected.CRITICAL_BATCHES} color="#ef4444" />
                <AlertBadge label="Temp Excursions" count={selected.TEMP_EXCURSIONS} color="#f97316" />
                <AlertBadge label="Critical Stock Items" count={selected.CRITICAL_STOCK_ITEMS} color="#eab308" />
                <AlertBadge label="Delayed Shipments" count={selected.DELAYED_SHIPMENTS} color="#f97316" />
                {selected.CRITICAL_BATCHES + selected.TEMP_EXCURSIONS + selected.CRITICAL_STOCK_ITEMS + selected.DELAYED_SHIPMENTS === 0 && (
                  <div style={{ color: '#22c55e', fontSize: 12, padding: '4px 0' }}>✓ No active alerts</div>
                )}
              </div>
            </div>

            <div style={{ display: 'flex', borderBottom: '1px solid rgba(255,255,255,0.08)' }}>
              {(['batches', 'inventory'] as const).map(tab => (
                <button key={tab} onClick={() => setActiveTab(tab)} style={{ flex: 1, padding: '10px 0', background: 'transparent', border: 'none', borderBottom: activeTab === tab ? '2px solid var(--accent, #29b5e8)' : '2px solid transparent', color: activeTab === tab ? 'var(--accent, #29b5e8)' : 'var(--text-muted, #888)', cursor: 'pointer', fontSize: 12, fontWeight: 600, textTransform: 'capitalize' }}>
                  {tab}
                </button>
              ))}
            </div>

            <div style={{ flex: 1, overflowY: 'auto', padding: '8px 0' }}>
              {activeTab === 'batches' && batches.map((b, i) => (
                <div key={i} style={{ padding: '10px 20px', borderBottom: '1px solid rgba(255,255,255,0.05)' }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 4 }}>
                    <div style={{ fontWeight: 600, fontSize: 12 }}>{b.PRODUCT_NAME}</div>
                    <BatchStatusBadge status={b.STATUS} severity={b.DEVIATION_SEVERITY} />
                  </div>
                  <div style={{ fontSize: 11, color: 'var(--text-muted, #888)', marginBottom: 2 }}>{b.BATCH_NUMBER} · {b.BUSINESS_LINE}</div>
                  {b.YIELD_PCT && <div style={{ fontSize: 11, color: 'var(--text-muted, #888)' }}>Yield: {b.YIELD_PCT}%</div>}
                  {b.DEVIATION_COUNT > 0 && (
                    <div style={{ fontSize: 11, color: b.DEVIATION_SEVERITY === 'CRITICAL' ? '#ef4444' : b.DEVIATION_SEVERITY === 'MAJOR' ? '#f97316' : '#eab308', marginTop: 2 }}>
                      ⚠ {b.DEVIATION_COUNT} {b.DEVIATION_SEVERITY?.toLowerCase()} deviation{b.DEVIATION_COUNT > 1 ? 's' : ''}
                    </div>
                  )}
                  {b.COST_USD_M > 0 && <div style={{ fontSize: 11, color: 'var(--text-muted, #888)' }}>Batch value: ${b.COST_USD_M}M</div>}
                </div>
              ))}
              {activeTab === 'batches' && batches.length === 0 && !loadingBuildings && (
                <div style={{ padding: '20px', fontSize: 12, color: 'var(--text-muted, #888)', textAlign: 'center' }}>No active batches</div>
              )}

              {activeTab === 'inventory' && inventory.map((inv, i) => (
                <div key={i} style={{ padding: '10px 20px', borderBottom: '1px solid rgba(255,255,255,0.05)' }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 4 }}>
                    <div style={{ fontWeight: 600, fontSize: 12 }}>{inv.PRODUCT_NAME}</div>
                    <span style={{ fontSize: 10, fontWeight: 600, color: inv.STOCK_STATUS === 'CRITICAL' ? '#ef4444' : inv.STOCK_STATUS === 'LOW' ? '#eab308' : inv.STOCK_STATUS === 'EXCESS' ? '#3b82f6' : '#22c55e', background: (inv.STOCK_STATUS === 'CRITICAL' ? '#ef4444' : inv.STOCK_STATUS === 'LOW' ? '#eab308' : '#22c55e') + '22', padding: '2px 6px', borderRadius: 4 }}>
                      {inv.STOCK_STATUS}
                    </span>
                  </div>
                  <div style={{ fontSize: 11, color: 'var(--text-muted, #888)', marginBottom: 2 }}>{inv.BUSINESS_LINE} · {inv.MATERIAL_TYPE}</div>
                  <div style={{ fontSize: 11, color: 'var(--text-muted, #888)' }}>{inv.STOCK_KG} kg · {inv.DAYS_OF_COVERAGE} days cover</div>
                  {inv.TEMP_EXCURSION_FLAG && (
                    <div style={{ fontSize: 11, color: '#f97316', marginTop: 2 }}>🌡 Temperature excursion detected</div>
                  )}
                </div>
              ))}
              {activeTab === 'inventory' && inventory.length === 0 && !loadingBuildings && (
                <div style={{ padding: '20px', fontSize: 12, color: 'var(--text-muted, #888)', textAlign: 'center' }}>No inventory data</div>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}

import { Router } from 'express';

type RunSql = (sql: string, database?: string, schema?: string) => Promise<any[]>;

const up = (rows: any[]) => rows.map(row => {
  const r: Record<string, any> = {};
  for (const [k, v] of Object.entries(row)) r[k.toUpperCase()] = v;
  return r;
});

// ─── Seeded RNG ───────────────────────────────────────────────────────────────
function seededRng(seed: number) {
  let s = seed;
  return (n = 1) => { s = (s * 1664525 + 1013904223) & 0xffffffff; return ((s >>> 0) / 0xffffffff) * n; };
}
function lerp(a: number, b: number, t: number) { return a + (b - a) * t; }
function rect(minLon: number, maxLon: number, minLat: number, maxLat: number): [number, number][] {
  return [[minLon, minLat], [maxLon, minLat], [maxLon, maxLat], [minLon, maxLat], [minLon, minLat]];
}
function bbox(geojson: any): { minLon: number; maxLon: number; minLat: number; maxLat: number } | null {
  const coords: [number, number][] = [];
  const ex = (c: any) => { if (typeof c[0] === 'number') coords.push(c as [number, number]); else c.forEach(ex); };
  try {
    if (geojson.type === 'Polygon') ex(geojson.coordinates);
    else if (geojson.type === 'MultiPolygon') geojson.coordinates.forEach((p: any) => ex(p));
    else return null;
  } catch { return null; }
  if (!coords.length) return null;
  return { minLon: Math.min(...coords.map(c => c[0])), maxLon: Math.max(...coords.map(c => c[0])), minLat: Math.min(...coords.map(c => c[1])), maxLat: Math.max(...coords.map(c => c[1])) };
}
function centroid(geojson: any): [number, number] | null {
  const b = bbox(geojson);
  if (!b) return null;
  return [(b.minLon + b.maxLon) / 2, (b.minLat + b.maxLat) / 2];
}

// ─── Pharma campus definitions ────────────────────────────────────────────────

const CAMPUS_ROLES = [
  { id: 'api', name: 'API Manufacturing', short: 'API', color: [168, 85, 247, 200] as [number,number,number,number], floorCount: 3 },
  { id: 'form', name: 'Formulation & Filling', short: 'FORM', color: [59, 130, 246, 200] as [number,number,number,number], floorCount: 2 },
  { id: 'cold', name: 'Cold Chain Warehouse', short: 'COLD', color: [6, 182, 212, 200] as [number,number,number,number], floorCount: 1 },
  { id: 'qc', name: 'QC Laboratory', short: 'QC', color: [234, 179, 8, 200] as [number,number,number,number], floorCount: 2 },
  { id: 'util', name: 'Central Utilities', short: 'UTIL', color: [107, 114, 128, 200] as [number,number,number,number], floorCount: 2 },
  { id: 'dist', name: 'Distribution & Dispatch', short: 'DIST', color: [180, 83, 9, 200] as [number,number,number,number], floorCount: 1 },
];

// Zone definitions per building role per floor
const BUILDING_FLOORS: Record<string, { floorLabel: string; zones: { id: string; name: string; type: string; fraction: [number, number, number, number]; elevation: number }[] }[]> = {
  api: [
    { floorLabel: 'Ground Floor (Synthesis)', zones: [
      { id: 'reactor_hall', name: 'Reactor Hall', type: 'reactor', fraction: [0, 0.5, 0, 0.6], elevation: 12 },
      { id: 'solvent_store', name: 'Solvent Store', type: 'hazardous', fraction: [0.5, 1, 0, 0.4], elevation: 8 },
      { id: 'ipc_lab', name: 'IPC Lab', type: 'lab', fraction: [0.5, 1, 0.4, 1], elevation: 5 },
      { id: 'cleanroom_a', name: 'Cleanroom Prep A', type: 'cleanroom', fraction: [0, 0.5, 0.6, 1], elevation: 6 },
    ]},
    { floorLabel: 'First Floor (Purification)', zones: [
      { id: 'distillation', name: 'Distillation Units', type: 'process', fraction: [0, 0.55, 0, 0.55], elevation: 10 },
      { id: 'crystallisation', name: 'Crystallisation', type: 'process', fraction: [0.55, 1, 0, 0.55], elevation: 8 },
      { id: 'filtration', name: 'Filtration Suite', type: 'process', fraction: [0, 0.55, 0.55, 1], elevation: 6 },
      { id: 'holding_tanks', name: 'Holding Tanks', type: 'storage', fraction: [0.55, 1, 0.55, 1], elevation: 7 },
    ]},
    { floorLabel: 'Second Floor (QC Hold)', zones: [
      { id: 'qc_hold', name: 'QC Hold Area', type: 'quarantine', fraction: [0, 0.5, 0, 0.5], elevation: 5 },
      { id: 'sampling', name: 'Sampling Station', type: 'lab', fraction: [0.5, 1, 0, 0.5], elevation: 4 },
      { id: 'packaging_api', name: 'Drum Packaging', type: 'packaging', fraction: [0, 1, 0.5, 1], elevation: 5 },
    ]},
  ],
  form: [
    { floorLabel: 'Ground Floor (Manufacturing)', zones: [
      { id: 'granulation', name: 'Granulation Suite', type: 'process', fraction: [0, 0.5, 0, 0.5], elevation: 8 },
      { id: 'tablet_press', name: 'Tablet Press Area', type: 'process', fraction: [0.5, 1, 0, 0.5], elevation: 8 },
      { id: 'blending', name: 'Blending Room', type: 'process', fraction: [0, 0.5, 0.5, 1], elevation: 7 },
      { id: 'filling_line', name: 'Vial Filling Line', type: 'aseptic', fraction: [0.5, 1, 0.5, 1], elevation: 9 },
    ]},
    { floorLabel: 'First Floor (Packaging)', zones: [
      { id: 'coating_pan', name: 'Film Coating Pans', type: 'process', fraction: [0, 0.5, 0, 0.45], elevation: 7 },
      { id: 'primary_pack', name: 'Primary Packaging', type: 'packaging', fraction: [0.5, 1, 0, 0.45], elevation: 6 },
      { id: 'secondary_pack', name: 'Secondary Packaging', type: 'packaging', fraction: [0, 1, 0.45, 0.75], elevation: 5 },
      { id: 'labelling', name: 'Labelling & Serialisation', type: 'packaging', fraction: [0, 1, 0.75, 1], elevation: 4 },
    ]},
  ],
  cold: [
    { floorLabel: 'Ground Floor', zones: [
      { id: 'freezer_a', name: 'Ultra-Low Freezer −80°C', type: 'freezer', fraction: [0, 0.3, 0, 0.5], elevation: 10 },
      { id: 'freezer_b', name: 'Deep Freeze −20°C', type: 'deep_freeze', fraction: [0.3, 0.6, 0, 0.5], elevation: 10 },
      { id: 'chill_store', name: 'Chill Store +4°C', type: 'chill', fraction: [0.6, 1, 0, 0.5], elevation: 9 },
      { id: 'quarantine_cold', name: 'Quarantine Cold', type: 'quarantine', fraction: [0, 0.35, 0.5, 1], elevation: 8 },
      { id: 'dispensary', name: 'Cold Dispensary', type: 'dispensary', fraction: [0.35, 0.7, 0.5, 1], elevation: 7 },
      { id: 'loading_cold', name: 'Loading Bay (Temp-Controlled)', type: 'dock', fraction: [0.7, 1, 0.5, 1], elevation: 5 },
    ]},
  ],
  qc: [
    { floorLabel: 'Ground Floor (Wet Chemistry)', zones: [
      { id: 'wet_chem', name: 'Wet Chemistry Lab', type: 'lab', fraction: [0, 0.5, 0, 0.5], elevation: 5 },
      { id: 'micro_lab', name: 'Microbiology Suite', type: 'cleanroom', fraction: [0.5, 1, 0, 0.5], elevation: 6 },
      { id: 'sample_receipt', name: 'Sample Receipt', type: 'storage', fraction: [0, 0.5, 0.5, 1], elevation: 4 },
      { id: 'stability_chamber', name: 'Stability Chambers', type: 'storage', fraction: [0.5, 1, 0.5, 1], elevation: 6 },
    ]},
    { floorLabel: 'First Floor (Analytical)', zones: [
      { id: 'hplc_room', name: 'HPLC Suite', type: 'analytical', fraction: [0, 0.5, 0, 0.45], elevation: 5 },
      { id: 'dissolution', name: 'Dissolution Testing', type: 'analytical', fraction: [0.5, 1, 0, 0.45], elevation: 4 },
      { id: 'balance_room', name: 'Balance Room', type: 'precision', fraction: [0, 0.45, 0.45, 1], elevation: 4 },
      { id: 'spec_room', name: 'Spectroscopy Room', type: 'analytical', fraction: [0.45, 1, 0.45, 1], elevation: 4 },
    ]},
  ],
  util: [
    { floorLabel: 'Ground Floor (Water Systems)', zones: [
      { id: 'pw_system', name: 'Purified Water System', type: 'utility', fraction: [0, 0.5, 0, 0.5], elevation: 6 },
      { id: 'wfi_system', name: 'WFI Generation', type: 'utility', fraction: [0.5, 1, 0, 0.5], elevation: 7 },
      { id: 'steam_gen', name: 'Clean Steam Generator', type: 'utility', fraction: [0, 0.5, 0.5, 1], elevation: 6 },
      { id: 'waste_treat', name: 'Effluent Treatment', type: 'utility', fraction: [0.5, 1, 0.5, 1], elevation: 5 },
    ]},
    { floorLabel: 'First Floor (HVAC & Power)', zones: [
      { id: 'ahu_bank', name: 'AHU Bank', type: 'hvac', fraction: [0, 0.6, 0, 0.5], elevation: 5 },
      { id: 'chiller_plant', name: 'Chiller Plant', type: 'hvac', fraction: [0.6, 1, 0, 0.5], elevation: 6 },
      { id: 'ups_room', name: 'UPS / Electrical', type: 'electrical', fraction: [0, 0.5, 0.5, 1], elevation: 4 },
      { id: 'bms_room', name: 'BMS Control Room', type: 'control', fraction: [0.5, 1, 0.5, 1], elevation: 4 },
    ]},
  ],
  dist: [
    { floorLabel: 'Ground Floor', zones: [
      { id: 'fg_ambient', name: 'Finished Goods (Ambient)', type: 'warehouse', fraction: [0, 0.45, 0, 0.6], elevation: 10 },
      { id: 'fg_cold', name: 'Finished Goods (Cold)', type: 'chill', fraction: [0.45, 0.75, 0, 0.6], elevation: 9 },
      { id: 'dispatch_bay', name: 'Dispatch Bay', type: 'dock', fraction: [0.75, 1, 0, 0.55], elevation: 5 },
      { id: 'returns', name: 'Returns & Recalls', type: 'quarantine', fraction: [0.75, 1, 0.55, 1], elevation: 5 },
      { id: 'receipt', name: 'Goods Receipt', type: 'dock', fraction: [0, 0.45, 0.6, 1], elevation: 5 },
      { id: 'staging', name: 'Order Staging', type: 'warehouse', fraction: [0.45, 0.75, 0.6, 1], elevation: 6 },
    ]},
  ],
};

// Sensor templates per zone type
interface SensorTemplate { type: string; name: string; unit: string; normalRange: [number, number]; criticalRange?: [number, number]; }
const ZONE_SENSORS: Record<string, SensorTemplate[]> = {
  reactor:     [{ type:'temperature', name:'Vessel Temp', unit:'°C', normalRange:[60,80], criticalRange:[90,100] }, { type:'pressure', name:'Vessel Pressure', unit:'bar', normalRange:[1.5,2.5], criticalRange:[3,4] }, { type:'ph', name:'pH Monitor', unit:'pH', normalRange:[6.5,7.5] }, { type:'rpm', name:'Agitator RPM', unit:'rpm', normalRange:[100,300] }, { type:'dissolved_o2', name:'Dissolved O₂', unit:'% sat', normalRange:[30,80] }],
  process:     [{ type:'temperature', name:'Process Temp', unit:'°C', normalRange:[20,60] }, { type:'humidity', name:'Humidity', unit:'%', normalRange:[40,60] }, { type:'diff_pressure', name:'Diff Pressure', unit:'Pa', normalRange:[5,20] }, { type:'vibration', name:'Equipment Vibration', unit:'mm/s', normalRange:[0,5] }],
  aseptic:     [{ type:'temperature', name:'Room Temp', unit:'°C', normalRange:[18,22] }, { type:'humidity', name:'Humidity', unit:'%', normalRange:[40,55] }, { type:'diff_pressure', name:'Diff Pressure', unit:'Pa', normalRange:[15,30] }, { type:'particle_count', name:'Particle Count (≥0.5µm)', unit:'ptcl/m³', normalRange:[0,3500] }, { type:'viable_particle', name:'Viable Particles', unit:'CFU/m³', normalRange:[0,1] }],
  cleanroom:   [{ type:'temperature', name:'Room Temp', unit:'°C', normalRange:[18,22] }, { type:'humidity', name:'Humidity', unit:'%', normalRange:[40,60] }, { type:'diff_pressure', name:'Diff Pressure', unit:'Pa', normalRange:[10,25] }, { type:'particle_count', name:'Non-Viable Particles', unit:'ptcl/m³', normalRange:[0,35200] }],
  lab:         [{ type:'temperature', name:'Lab Temp', unit:'°C', normalRange:[18,25] }, { type:'humidity', name:'Humidity', unit:'%', normalRange:[40,65] }, { type:'co2', name:'CO₂ Level', unit:'ppm', normalRange:[400,1000] }],
  analytical:  [{ type:'temperature', name:'Room Temp', unit:'°C', normalRange:[20,22] }, { type:'humidity', name:'Humidity', unit:'%', normalRange:[45,55] }, { type:'power', name:'Instrument Power', unit:'kW', normalRange:[0.5,3] }],
  freezer:     [{ type:'temperature', name:'Chamber Temp', unit:'°C', normalRange:[-85,-75], criticalRange:[-70,-60] }, { type:'temperature', name:'Rack Temp A', unit:'°C', normalRange:[-85,-75] }, { type:'door', name:'Door Status', unit:'open/closed', normalRange:[0,0] }, { type:'alarm', name:'Temp Alarm', unit:'status', normalRange:[0,0] }],
  deep_freeze: [{ type:'temperature', name:'Chamber Temp', unit:'°C', normalRange:[-25,-18], criticalRange:[-15,-10] }, { type:'temperature', name:'Rack Temp B', unit:'°C', normalRange:[-25,-18] }, { type:'door', name:'Door Status', unit:'open/closed', normalRange:[0,0] }],
  chill:       [{ type:'temperature', name:'Chamber Temp', unit:'°C', normalRange:[2,8], criticalRange:[10,15] }, { type:'humidity', name:'Humidity', unit:'%', normalRange:[50,75] }, { type:'door', name:'Door Status', unit:'open/closed', normalRange:[0,0] }],
  quarantine:  [{ type:'temperature', name:'Room Temp', unit:'°C', normalRange:[15,25] }, { type:'humidity', name:'Humidity', unit:'%', normalRange:[40,65] }, { type:'access', name:'Access Control', unit:'events/hr', normalRange:[0,5] }],
  utility:     [{ type:'toc', name:'TOC', unit:'ppb', normalRange:[0,300], criticalRange:[400,600] }, { type:'conductivity', name:'Conductivity', unit:'µS/cm', normalRange:[0,1.3], criticalRange:[1.5,2] }, { type:'flow', name:'Flow Rate', unit:'L/min', normalRange:[5,30] }],
  hvac:        [{ type:'temperature', name:'Supply Air Temp', unit:'°C', normalRange:[15,18] }, { type:'flow', name:'Air Flow', unit:'m³/h', normalRange:[1000,3000] }, { type:'pressure', name:'Filter dP', unit:'Pa', normalRange:[50,200], criticalRange:[250,350] }, { type:'vibration', name:'Fan Vibration', unit:'mm/s', normalRange:[0,4] }],
  packaging:   [{ type:'temperature', name:'Room Temp', unit:'°C', normalRange:[18,25] }, { type:'humidity', name:'Humidity', unit:'%', normalRange:[40,60] }, { type:'compression', name:'Compression Force', unit:'kN', normalRange:[5,15] }],
  warehouse:   [{ type:'temperature', name:'Ambient Temp', unit:'°C', normalRange:[15,25] }, { type:'humidity', name:'Humidity', unit:'%', normalRange:[35,65] }],
  dock:        [{ type:'temperature', name:'Bay Temp', unit:'°C', normalRange:[10,30] }, { type:'co2', name:'CO₂ (vehicle exhaust)', unit:'ppm', normalRange:[400,1500] }],
  electrical:  [{ type:'power', name:'UPS Load', unit:'kW', normalRange:[20,80] }, { type:'temperature', name:'Room Temp', unit:'°C', normalRange:[18,26] }],
  control:     [{ type:'temperature', name:'Room Temp', unit:'°C', normalRange:[18,24] }, { type:'power', name:'Server Load', unit:'kW', normalRange:[1,8] }],
  hazardous:   [{ type:'temperature', name:'Store Temp', unit:'°C', normalRange:[15,25] }, { type:'co2', name:'Vapour Detector', unit:'ppm', normalRange:[0,200] }],
  precision:   [{ type:'temperature', name:'Room Temp', unit:'°C', normalRange:[20,22] }, { type:'humidity', name:'Humidity', unit:'%', normalRange:[45,55] }, { type:'vibration', name:'Anti-vibration Table', unit:'µm', normalRange:[0,3] }],
  dispensary:  [{ type:'temperature', name:'Dispensary Temp', unit:'°C', normalRange:[2,8] }, { type:'diff_pressure', name:'Diff Pressure', unit:'Pa', normalRange:[10,20] }],
  storage:     [{ type:'temperature', name:'Store Temp', unit:'°C', normalRange:[15,25] }, { type:'humidity', name:'Humidity', unit:'%', normalRange:[40,65] }],
};

// Contents per zone type (shelves, pallets, equipment)
function buildContents(zoneType: string, zoneName: string, plantId: number, zoneIdx: number, rng: () => number) {
  const type = zoneType;
  if (type === 'reactor') {
    return { contentType: 'equipment', items: [
      { id:`R-${plantId}01`, name:'Reactor 101', role:'Synthesis Vessel', capacity:'5000L', status:rng()<0.3?'Fault':'Running', batch:`B-${2400+Math.round(rng()*50)}`, product:'Active API', temperature:`${Math.round(60+rng()*25)}°C`, pressure:`${Math.round(15+rng()*20)/10} bar` },
      { id:`R-${plantId}02`, name:'Reactor 102', role:'Transfer Vessel', capacity:'2000L', status:rng()<0.15?'Standby':'Running', batch:`B-${2450+Math.round(rng()*50)}`, product:'Intermediate', temperature:`${Math.round(40+rng()*30)}°C`, pressure:`${Math.round(10+rng()*15)/10} bar` },
      { id:`HEX-${plantId}01`, name:'Heat Exchanger 01', role:'Cooling', capacity:'500kW', status:'Running', temperature:`${Math.round(20+rng()*15)}°C`, pressure:'N/A' },
    ]};
  }
  if (type === 'aseptic' || type === 'packaging') {
    return { contentType: 'production_line', items: [
      { id:`FL-${plantId}01`, name:'Filling Line 1', type:'Vial Filler', status:rng()<0.2?'Fault':'Running', speed:`${Math.round(3000+rng()*2000)} vials/hr`, lastBatch:`B-${2480+Math.round(rng()*20)}` },
      { id:`TP-${plantId}01`, name:'Tablet Press 1', type:'Rotary Press', status:rng()<0.15?'Changeover':'Running', speed:`${Math.round(80000+rng()*40000)} tabs/hr`, compression:`${Math.round(8+rng()*7)} kN` },
      { id:`CP-${plantId}01`, name:'Coating Pan', type:'Film Coater', status:'Running', batch:`B-${2490+Math.round(rng()*10)}`, product:'Coated Tablet' },
    ]};
  }
  if (type === 'freezer' || type === 'deep_freeze' || type === 'chill' || type === 'warehouse' || type === 'storage' || type === 'dispensary') {
    const products = ['Insulin Glargine', 'Adalimumab', 'Semaglutide', 'Budesonide', 'Clopidogrel', 'Warfarin', 'Atorvastatin', 'Nitroglycerin', 'Methotrexate', 'Ozempic'];
    const count = Math.round(4 + rng() * 8);
    return { contentType: 'racking', items: Array.from({length: count}, (_, i) => {
      const daysLeft = Math.round(20 + rng() * 500);
      const product = products[Math.floor(rng() * products.length)];
      const batchNo = `B-${2200+Math.round(rng()*300)}`;
      const pallets = Math.round(1 + rng() * 8);
      return {
        id:`RACK-${String.fromCharCode(65+i)}${Math.round(rng()*9)}`, name:`Rack ${String.fromCharCode(65+i)}`,
        product, batchNo, pallets:`${pallets} pallets`,
        stockKg:`${Math.round(50+rng()*950)} kg`,
        expiryDate: new Date(Date.now()+daysLeft*86400000).toISOString().slice(0,10),
        daysLeft, expiryStatus: daysLeft<30?'critical':daysLeft<90?'warning':'ok',
        temperature: type==='freezer'?`${Math.round(-84+rng()*6)}°C`:type==='deep_freeze'?`${Math.round(-24+rng()*5)}°C`:type==='chill'?`${Math.round(2+rng()*6)}°C`:`${Math.round(16+rng()*9)}°C`,
      };
    })};
  }
  if (type === 'analytical' || type === 'lab' || type === 'precision') {
    return { contentType: 'instruments', items: [
      { id:'HPLC-01', name:'HPLC System 1', model:'Agilent 1260', status:rng()<0.2?'Maintenance':'Idle', lastRun:new Date(Date.now()-Math.round(rng()*7)*86400000).toISOString().slice(0,10) },
      { id:'DISS-01', name:'Dissolution Bath', model:'Distek 2100C', status:'Running', method:`Method ${Math.round(10+rng()*90)}`, samples:`${Math.round(6+rng()*6)} vessels` },
      { id:'FT-01', name:'FTIR Spectrometer', model:'Thermo Nicolet iS20', status:'Idle' },
      { id:'BAL-01', name:'Analytical Balance', model:'Mettler Toledo XPE', status:'Calibrated', lastCal:new Date(Date.now()-Math.round(rng()*30)*86400000).toISOString().slice(0,10) },
    ]};
  }
  if (type === 'process') {
    return { contentType: 'equipment', items: [
      { id:`PMP-${plantId}01`, name:'Transfer Pump 1', role:'Centrifugal Pump', status:rng()<0.1?'Fault':'Running', flowRate:`${Math.round(50+rng()*150)} L/hr`, pressure:`${Math.round(10+rng()*20)/10} bar` },
      { id:`HEX-${plantId}02`, name:'Heat Exchanger 02', role:'Shell & Tube', status:rng()<0.15?'Maintenance':'Running', temperature:`${Math.round(40+rng()*40)}°C`, duty:`${Math.round(100+rng()*400)} kW` },
      { id:`FLT-${plantId}01`, name:'Filter Housing 1', role:'0.2µm Cartridge', status:rng()<0.2?'Change Required':'OK', dP:`${Math.round(1+rng()*4)/10} bar`, installed:new Date(Date.now()-Math.round(rng()*60)*86400000).toISOString().slice(0,10) },
      { id:`TNK-${plantId}03`, name:'Buffer Tank', role:'Hold Vessel', status:'Running', volume:`${Math.round(500+rng()*1500)} L`, fill:`${Math.round(30+rng()*65)}%` },
    ]};
  }
  if (type === 'hazardous') {
    const solvents = ['Acetonitrile','Ethanol 96%','Isopropanol','Methanol','Dichloromethane','Ethyl Acetate','Acetone','Toluene'];
    const count = Math.round(3 + rng() * 5);
    return { contentType: 'racking', items: Array.from({length: count}, (_, i) => {
      const solvent = solvents[Math.floor(rng() * solvents.length)];
      const daysLeft = Math.round(30 + rng() * 180);
      return {
        id:`SOL-${String.fromCharCode(65+i)}`, name:`Bay ${String.fromCharCode(65+i)}`,
        product: solvent, batchNo:`DR-${Math.round(1000+rng()*8000)}`,
        pallets:`${Math.round(1+rng()*4)} drums`, stockKg:`${Math.round(25+rng()*200)} kg`,
        expiryDate: new Date(Date.now()+daysLeft*86400000).toISOString().slice(0,10),
        daysLeft, expiryStatus: daysLeft<30?'critical':daysLeft<90?'warning':'ok',
        temperature:`${Math.round(15+rng()*10)}°C`,
      };
    })};
  }
  if (type === 'cleanroom') {
    return { contentType: 'equipment', items: [
      { id:`BSC-${plantId}01`, name:'Biosafety Cabinet 1', role:'Class II Type A2', status:rng()<0.1?'Maintenance':'Certified', lastCert:new Date(Date.now()-Math.round(rng()*180)*86400000).toISOString().slice(0,10) },
      { id:`LAF-${plantId}01`, name:'LAF Workstation', role:'Horizontal Laminar Flow', status:'Running', filterStatus:rng()<0.15?'Replace Soon':'OK' },
      { id:`GWN-${plantId}01`, name:'Gowning Station', role:'Personnel Airlock', status:'Operational', occupancy:`${Math.round(rng()*4)} persons` },
      { id:`SSK-${plantId}01`, name:'Sink Station', role:'Stainless Steel Wash', status:'Operational' },
    ]};
  }
  if (type === 'quarantine') {
    const count = Math.round(3 + rng() * 6);
    return { contentType: 'racking', items: Array.from({length: count}, (_, i) => {
      const daysLeft = Math.round(5 + rng() * 60);
      const products = ['Bulk API','Finished Goods','Raw Material','Excipient','Packaging'];
      return {
        id:`QH-${String.fromCharCode(65+i)}${Math.round(rng()*9)}`, name:`Hold ${String.fromCharCode(65+i)}`,
        product: products[Math.floor(rng() * products.length)],
        batchNo:`B-${2100+Math.round(rng()*400)}`, pallets:`${Math.round(1+rng()*6)} units`,
        stockKg:`${Math.round(10+rng()*500)} kg`,
        expiryDate: new Date(Date.now()+daysLeft*86400000).toISOString().slice(0,10),
        daysLeft, expiryStatus: daysLeft<14?'critical':daysLeft<30?'warning':'ok',
        temperature:`${Math.round(18+rng()*6)}°C`,
      };
    })};
  }
  if (type === 'dock') {
    return { contentType: 'equipment', items: [
      { id:`BCK-${plantId}01`, name:'Loading Bay 1', role:'Temperature-Controlled', status:rng()<0.2?'Occupied':'Available', truck:rng()<0.4?`TRK-${Math.round(100+rng()*900)}`:'Empty', tempZone:`${Math.round(2+rng()*6)}°C` },
      { id:`BCK-${plantId}02`, name:'Loading Bay 2', role:'Ambient', status:rng()<0.3?'Occupied':'Available', truck:rng()<0.3?`TRK-${Math.round(100+rng()*900)}`:'Empty' },
      { id:`CNV-${plantId}01`, name:'Conveyor System', role:'Roller Conveyor', status:rng()<0.1?'Fault':'Running', speed:`${Math.round(0.2+rng()*0.8)} m/s` },
      { id:`SLR-${plantId}01`, name:'Stretch Wrap Station', role:'Pallet Wrapper', status:'Standby' },
    ]};
  }
  if (type === 'hvac') {
    return { contentType: 'equipment', items: [
      { id:`AHU-${plantId}01`, name:`AHU-${plantId}-01`, role:'Air Handling Unit', status:rng()<0.1?'Alarm':'Running', airflow:`${Math.round(5000+rng()*10000)} m³/hr`, filterDP:`${Math.round(80+rng()*150)} Pa` },
      { id:`AHU-${plantId}02`, name:`AHU-${plantId}-02`, role:'Air Handling Unit', status:'Running', airflow:`${Math.round(3000+rng()*8000)} m³/hr`, filterDP:`${Math.round(60+rng()*120)} Pa` },
      { id:`CHW-${plantId}01`, name:'Chilled Water Coil', role:'Cooling Coil', status:'Running', supplyTemp:`${Math.round(6+rng()*4)}°C`, returnTemp:`${Math.round(11+rng()*3)}°C` },
    ]};
  }
  if (type === 'electrical') {
    return { contentType: 'equipment', items: [
      { id:`UPS-${plantId}01`, name:'UPS Unit 1', role:'400kVA UPS', status:rng()<0.1?'On Battery':'On Mains', batteryHealth:`${Math.round(75+rng()*25)}%`, load:`${Math.round(30+rng()*60)}%` },
      { id:`SWB-${plantId}01`, name:'Main Switchboard', role:'MV/LV Panel', status:'Energised', voltage:'415V AC', current:`${Math.round(100+rng()*300)} A` },
      { id:`GEN-${plantId}01`, name:'Standby Generator', role:'500kVA Diesel', status:rng()<0.1?'Running':'Standby', fuelLevel:`${Math.round(40+rng()*60)}%` },
    ]};
  }
  if (type === 'control') {
    return { contentType: 'equipment', items: [
      { id:`WS-${plantId}01`, name:'SCADA Workstation 1', role:'Process Control', status:'Running', activeAlarms:`${Math.round(rng()*5)}`, lastAck:new Date(Date.now()-Math.round(rng()*120)*60000).toISOString().slice(11,19) },
      { id:`WS-${plantId}02`, name:'SCADA Workstation 2', role:'Historian', status:'Running' },
      { id:`SRV-${plantId}01`, name:'Application Server', role:'DCS Server', status:rng()<0.05?'Fault':'Running', cpu:`${Math.round(10+rng()*60)}%`, memory:`${Math.round(40+rng()*40)}%` },
      { id:`PLC-${plantId}01`, name:'PLC Cabinet 1', role:'Siemens S7-400', status:'Running', program:'v4.2.1' },
    ]};
  }
  if (type === 'utility') {
    return { contentType: 'plant', items: [
      { id:`PW-${plantId}01`, name:'Purified Water Plant', capacity:'10,000 L/day', status:'Running', toc:`${Math.round(50+rng()*200)} ppb`, conductivity:`${Math.round(5+rng()*8)/10} µS/cm` },
      { id:`WFI-${plantId}01`, name:'WFI Still', capacity:'3,000 L/day', status:rng()<0.1?'Maintenance':'Running', temperature:`${Math.round(80+rng()*5)}°C` },
      { id:`STM-${plantId}01`, name:'Clean Steam Generator', capacity:'500 kg/hr', status:'Running', pressure:`${Math.round(3+rng()*2)/10} bar` },
    ]};
  }
  return { contentType: 'general', items: [] };
}

// Build sensors for a zone
function buildZoneSensors(zoneType: string, zoneId: string, plantId: number, rng: () => number) {
  const templates = ZONE_SENSORS[zoneType] || ZONE_SENSORS['warehouse'];
  return templates.map((t, i) => {
    const range = t.normalRange;
    const midpoint = (range[0] + range[1]) / 2;
    const deviation = (rng() - 0.5) * (range[1] - range[0]) * 0.8;
    let value = Math.round((midpoint + deviation) * 100) / 100;
    // Occasional out-of-range
    let status: 'critical' | 'warning' | 'ok' = 'ok';
    if (t.criticalRange && rng() < 0.15) {
      const cr = t.criticalRange;
      value = Math.round((cr[0] + rng() * (cr[1] - cr[0])) * 100) / 100;
      status = 'critical';
    } else if (rng() < 0.2) {
      // slightly out of normal range
      value = range[1] + Math.round(rng() * (range[1] - range[0]) * 0.3 * 100) / 100;
      status = 'warning';
    }
    let alert: string | null = null;
    if (status === 'critical') alert = `${t.name}: ${value}${t.unit} — CRITICAL`;
    else if (status === 'warning') alert = `${t.name}: ${value}${t.unit} — above target`;
    return { id: `${zoneId}_${t.type}_${i}`, name: t.name, type: t.type, unit: t.unit, value, status, alert };
  });
}

// Build 24h timeline for a building
function buildTimeline(roleId: string, plantId: number) {
  const rng = seededRng(plantId * 13337 + roleId.charCodeAt(0));
  return Array.from({length: 24}, (_, h) => {
    const label = `${String(h).padStart(2,'0')}:00`;
    const entry: any = { hour: label };
    if (roleId === 'api' || roleId === 'form') {
      entry['Vessel Temp (°C)'] = Math.round((65 + (rng()-0.5)*15) * 10) / 10;
      entry['Humidity (%)'] = Math.round((50 + (rng()-0.5)*20) * 10) / 10;
      entry['Diff Pressure (Pa)'] = Math.round((15 + (rng()-0.5)*10) * 10) / 10;
    } else if (roleId === 'cold') {
      entry['Freezer −20°C'] = Math.round((-21 + (rng()-0.5)*4) * 10) / 10;
      entry['Chill +4°C'] = Math.round((4.5 + (rng()-0.5)*3) * 10) / 10;
      entry['Ultra-Low −80°C'] = Math.round((-80 + (rng()-0.5)*5) * 10) / 10;
    } else if (roleId === 'util') {
      entry['TOC (ppb)'] = Math.round((150 + rng()*200) * 10) / 10;
      entry['Conductivity (µS/cm)'] = Math.round((0.5 + rng()*0.8) * 100) / 100;
      entry['WFI Temp (°C)'] = Math.round((82 + (rng()-0.5)*3) * 10) / 10;
    } else {
      entry['Temperature (°C)'] = Math.round((20 + (rng()-0.5)*6) * 10) / 10;
      entry['Humidity (%)'] = Math.round((55 + (rng()-0.5)*25) * 10) / 10;
    }
    return entry;
  });
}

// Generate floor plan zones as polygons from building bbox
function buildFloors(geojson: any, roleId: string, plantId: number) {
  const b = bbox(geojson);
  if (!b) return [];
  const rng = seededRng(plantId * 999 + roleId.charCodeAt(0));
  const floorDefs = BUILDING_FLOORS[roleId] || BUILDING_FLOORS['dist'];
  const { minLon, maxLon, minLat, maxLat } = b;
  const dLon = maxLon - minLon;
  const dLat = maxLat - minLat;

  return floorDefs.map((floorDef, fi) => {
    const zones = floorDef.zones.map((zd, zi) => {
      const [fMinX, fMaxX, fMinY, fMaxY] = zd.fraction;
      const zMinLon = lerp(minLon, maxLon, fMinX + 0.01);
      const zMaxLon = lerp(minLon, maxLon, fMaxX - 0.01);
      const zMinLat = lerp(minLat, maxLat, fMinY + 0.01);
      const zMaxLat = lerp(minLat, maxLat, fMaxY - 0.01);
      const sensors = buildZoneSensors(zd.type, zd.id, plantId, seededRng(plantId*7+roleId.charCodeAt(0)*13+fi*5+zi));
      const alertStatus = sensors.some(s => s.status === 'critical') ? 'critical' : sensors.some(s => s.status === 'warning') ? 'warning' : 'ok';
      const contents = buildContents(zd.type, zd.name, plantId, zi, seededRng(plantId*11+fi*7+zi*3));
      return {
        id: zd.id, name: zd.name, type: zd.type,
        polygon: rect(zMinLon, zMaxLon, zMinLat, zMaxLat),
        elevation: zd.elevation,
        alertStatus,
        sensors,
        contents,
      };
    });
    return { floorIndex: fi, label: floorDef.floorLabel, zones };
  });
}

// ─── Router ───────────────────────────────────────────────────────────────────

export function createPlantIntelRouter(runSql: RunSql): Router {
  const router = Router();

  router.get('/plants', async (_req, res) => {
    try {
      let rows: any[] = [];
      try {
        rows = up(await runSql(
          `SELECT PLANT_ID, PLANT_NAME, PLANT_CODE, CITY, COUNTRY, REGION,
                  SPECIALISATION, CAPACITY_BATCHES_MONTH, LATITUDE, LONGITUDE,
                  MAX_SEVERITY, BATCH_SEVERITY, TEMP_SEVERITY, STOCK_SEVERITY, SHIPMENT_SEVERITY,
                  CRITICAL_BATCHES, TEMP_EXCURSIONS, CRITICAL_STOCK_ITEMS,
                  DELAYED_SHIPMENTS, BATCHES_IN_PROGRESS
           FROM FLEET_INTELLIGENCE.PHARMA_SUPPLY_CHAIN.PLANT_ALERT_STATUS
           ORDER BY PLANT_ID`, 'FLEET_INTELLIGENCE', 'PHARMA_SUPPLY_CHAIN'));
      } catch {
        rows = up(await runSql(
          `SELECT PLANT_ID, PLANT_NAME, PLANT_CODE, CITY, COUNTRY, REGION,
                  SPECIALISATION, CAPACITY_BATCHES_MONTH, LATITUDE, LONGITUDE,
                  0 AS MAX_SEVERITY, 0 AS BATCH_SEVERITY, 0 AS TEMP_SEVERITY,
                  0 AS STOCK_SEVERITY, 0 AS SHIPMENT_SEVERITY,
                  0 AS CRITICAL_BATCHES, 0 AS TEMP_EXCURSIONS,
                  0 AS CRITICAL_STOCK_ITEMS, 0 AS DELAYED_SHIPMENTS, 0 AS BATCHES_IN_PROGRESS
           FROM FLEET_INTELLIGENCE.PHARMA_SUPPLY_CHAIN.PLANTS ORDER BY PLANT_ID`, 'FLEET_INTELLIGENCE', 'PHARMA_SUPPLY_CHAIN'));
      }
      res.json(Array.isArray(rows) ? rows : []);
    } catch (err: any) { res.status(500).json({ error: err.message }); }
  });

  router.get('/buildings', async (req, res) => {
    try {
      const plantId = parseInt(req.query.plant_id as string, 10);
      if (isNaN(plantId) || plantId < 1) return res.status(400).json({ error: 'Valid plant_id required' });
      const rows = up(await runSql(
        `SELECT OVERTURE_ID, GEOJSON, BUILDING_NAME, CLASS, HEIGHT, FOOTPRINT_TYPE, AREA_SQM
         FROM FLEET_INTELLIGENCE.PHARMA_SUPPLY_CHAIN.PLANT_PRIMARY_BUILDING
         WHERE PLANT_ID = ${plantId} AND GEOJSON IS NOT NULL`,
        'FLEET_INTELLIGENCE', 'PHARMA_SUPPLY_CHAIN'));
      const features = rows.map((r: any) => {
        let geometry: any = null;
        try { geometry = typeof r.GEOJSON === 'string' ? JSON.parse(r.GEOJSON) : r.GEOJSON; } catch {}
        return { type: 'Feature', geometry, properties: { id: r.OVERTURE_ID, name: r.BUILDING_NAME||null, class: r.CLASS||null, height: r.HEIGHT ? Number(r.HEIGHT) : 12, type: r.FOOTPRINT_TYPE, area_sqm: r.AREA_SQM ? Number(r.AREA_SQM) : null, is_plant_building: true } };
      }).filter((f: any) => f.geometry !== null);
      res.json({ type: 'FeatureCollection', features });
    } catch (err: any) { res.status(500).json({ error: err.message }); }
  });

  router.get('/campus', async (req, res) => {
    try {
      const plantId = parseInt(req.query.plant_id as string, 10);
      if (isNaN(plantId) || plantId < 1) return res.status(400).json({ error: 'Valid plant_id required' });

      const rows = up(await runSql(
        `SELECT OVERTURE_ID, GEOJSON, BUILDING_NAME, CLASS, HEIGHT, AREA_SQM, CAMPUS_RANK
         FROM FLEET_INTELLIGENCE.PHARMA_SUPPLY_CHAIN.PLANT_CAMPUS_BUILDINGS
         WHERE PLANT_ID = ${plantId} AND GEOJSON IS NOT NULL
         ORDER BY CAMPUS_RANK`,
        'FLEET_INTELLIGENCE', 'PHARMA_SUPPLY_CHAIN'));

      const campus = rows.slice(0, 6).map((r: any, idx: number) => {
        const role = CAMPUS_ROLES[idx] || CAMPUS_ROLES[CAMPUS_ROLES.length - 1];
        let geojson: any = null;
        try { geojson = typeof r.GEOJSON === 'string' ? JSON.parse(r.GEOJSON) : r.GEOJSON; } catch {}
        if (!geojson) return null;
        const areaSqm = r.AREA_SQM ? Number(r.AREA_SQM) : 5000;
        const floors = buildFloors(geojson, role.id, plantId);
        // Overall building alert = worst across all zones all floors
        const allZones = floors.flatMap(f => f.zones);
        const bldgAlert = allZones.some(z => z.alertStatus === 'critical') ? 'critical' : allZones.some(z => z.alertStatus === 'warning') ? 'warning' : 'ok';
        const timeline = buildTimeline(role.id, plantId);
        return {
          id: `bldg_${idx+1}`, overture_id: r.OVERTURE_ID,
          role: role.name, roleShort: role.short, roleId: role.id,
          color: role.color,
          geojson, areaSqm,
          floorCount: floors.length,
          floors,
          alertStatus: bldgAlert,
          timeline,
        };
      }).filter(Boolean);

      res.json({ campus });
    } catch (err: any) { res.status(500).json({ error: err.message }); }
  });

  // Legacy /warehouse endpoint (kept for backward compat)
  router.get('/warehouse', async (req, res) => {
    try {
      const plantId = parseInt(req.query.plant_id as string, 10);
      if (isNaN(plantId) || plantId < 1) return res.status(400).json({ error: 'Valid plant_id required' });
      const rows = up(await runSql(
        `SELECT GEOJSON, AREA_SQM FROM FLEET_INTELLIGENCE.PHARMA_SUPPLY_CHAIN.PLANT_PRIMARY_BUILDING
         WHERE PLANT_ID = ${plantId} AND GEOJSON IS NOT NULL LIMIT 1`,
        'FLEET_INTELLIGENCE', 'PHARMA_SUPPLY_CHAIN'));
      if (!rows.length) return res.status(404).json({ error: 'No primary building found' });
      let geojson: any = null;
      try { geojson = typeof rows[0].GEOJSON === 'string' ? JSON.parse(rows[0].GEOJSON) : rows[0].GEOJSON; } catch {}
      const areaSqm = rows[0].AREA_SQM ? Number(rows[0].AREA_SQM) : 10000;
      const b = bbox(geojson);
      if (!b) return res.status(422).json({ error: 'Cannot parse building' });
      const rng = seededRng(plantId * 7919);
      const floors = buildFloors(geojson, 'cold', plantId);
      const sensors = floors[0]?.zones.flatMap(z => z.sensors.map(s => ({ ...s, zoneId: z.id, position: centroid(geojson) || [0, 0] }))) || [];
      const timeline = buildTimeline('cold', plantId);
      res.json({ zones: floors[0]?.zones || [], sensors, sensorTimeline: timeline, bbox: b, areaSqm });
    } catch (err: any) { res.status(500).json({ error: err.message }); }
  });

  router.get('/batches', async (req, res) => {
    try {
      const plantId = parseInt(req.query.plant_id as string, 10);
      if (isNaN(plantId)) return res.status(400).json({ error: 'Valid plant_id required' });
      const rows = up(await runSql(
        `SELECT b.BATCH_NUMBER, pr.PRODUCT_NAME, pr.BUSINESS_LINE, b.STATUS, b.QC_RESULT,
                b.YIELD_PCT, b.DEVIATION_COUNT, b.DEVIATION_SEVERITY,
                TO_CHAR(b.PLANNED_COMPLETE, 'YYYY-MM-DD') AS PLANNED_COMPLETE,
                ROUND(b.COST_USD / 1000000, 2) AS COST_USD_M
         FROM FLEET_INTELLIGENCE.PHARMA_SUPPLY_CHAIN.PRODUCTION_BATCHES b
         JOIN FLEET_INTELLIGENCE.PHARMA_SUPPLY_CHAIN.PRODUCTS pr ON pr.PRODUCT_ID = b.PRODUCT_ID
         WHERE b.PLANT_ID = ${plantId}
         ORDER BY CASE b.STATUS WHEN 'ON_HOLD' THEN 1 WHEN 'REJECTED' THEN 2 WHEN 'QC_REVIEW' THEN 3 WHEN 'IN_PROGRESS' THEN 4 ELSE 5 END`,
        'FLEET_INTELLIGENCE', 'PHARMA_SUPPLY_CHAIN'));
      res.json(rows);
    } catch (err: any) { res.status(500).json({ error: err.message }); }
  });

  router.get('/inventory', async (req, res) => {
    try {
      const plantId = parseInt(req.query.plant_id as string, 10);
      if (isNaN(plantId)) return res.status(400).json({ error: 'Valid plant_id required' });
      const rows = up(await runSql(
        `SELECT pr.PRODUCT_NAME, pr.BUSINESS_LINE, mi.MATERIAL_TYPE, mi.STOCK_KG,
                mi.SAFETY_STOCK_KG, mi.DAYS_OF_COVERAGE, mi.STOCK_STATUS,
                mi.TEMP_EXCURSION_FLAG, TO_CHAR(mi.EXPIRY_DATE, 'YYYY-MM-DD') AS EXPIRY_DATE
         FROM FLEET_INTELLIGENCE.PHARMA_SUPPLY_CHAIN.MATERIAL_INVENTORY mi
         JOIN FLEET_INTELLIGENCE.PHARMA_SUPPLY_CHAIN.PRODUCTS pr ON pr.PRODUCT_ID = mi.PRODUCT_ID
         WHERE mi.PLANT_ID = ${plantId}
         ORDER BY CASE mi.STOCK_STATUS WHEN 'CRITICAL' THEN 1 WHEN 'LOW' THEN 2 ELSE 3 END, mi.TEMP_EXCURSION_FLAG DESC`,
        'FLEET_INTELLIGENCE', 'PHARMA_SUPPLY_CHAIN'));
      res.json(rows);
    } catch (err: any) { res.status(500).json({ error: err.message }); }
  });

  // ─── Robot telemetry from database ──────────────────────────────────────────
  router.get('/robots', async (req, res) => {
    try {
      const plantId = parseInt(req.query.plant_id as string, 10);
      if (isNaN(plantId)) return res.status(400).json({ error: 'Valid plant_id required' });
      const buildingRole = req.query.building_role as string | undefined;
      const floorIdx = req.query.floor_index !== undefined ? parseInt(req.query.floor_index as string, 10) : undefined;

      let where = `WHERE PLANT_ID = ${plantId}`;
      if (buildingRole) where += ` AND BUILDING_ROLE = '${buildingRole.replace(/'/g, "''")}'`;
      if (floorIdx !== undefined && !isNaN(floorIdx)) where += ` AND FLOOR_INDEX = ${floorIdx}`;

      const rows = up(await runSql(
        `SELECT ROBOT_ID, ROBOT_TYPE, ROBOT_TYPE_LABEL, STATUS, BUILDING_ROLE, BUILDING_ROLE_NAME,
                FLOOR_INDEX, CURRENT_ZONE, DESTINATION_ZONE, BATTERY_PCT, SPEED_MS,
                VIBRATION_MM_S, ONBOARD_TEMP_C, DISTANCE_TRAVELLED_M, UPTIME_HRS,
                MAINT_DUE_HRS, CARGO_BATCH, CARGO_KG
         FROM FLEET_INTELLIGENCE.PHARMA_SUPPLY_CHAIN.ROBOT_TELEMETRY
         ${where}
         ORDER BY BUILDING_ROLE, FLOOR_INDEX, ROBOT_TYPE, ROBOT_ID`,
        'FLEET_INTELLIGENCE', 'PHARMA_SUPPLY_CHAIN'));
      res.json(rows);
    } catch (err: any) { res.status(500).json({ error: err.message }); }
  });

  // Robot summary counts per building/type (lightweight for map legend)
  router.get('/robots/summary', async (req, res) => {
    try {
      const plantId = parseInt(req.query.plant_id as string, 10);
      if (isNaN(plantId)) return res.status(400).json({ error: 'Valid plant_id required' });
      const rows = up(await runSql(
        `SELECT BUILDING_ROLE, BUILDING_ROLE_NAME, FLOOR_INDEX, ROBOT_TYPE, ROBOT_TYPE_LABEL,
                COUNT(*) AS ROBOT_COUNT,
                COUNT_IF(STATUS = 'moving') AS MOVING,
                COUNT_IF(STATUS = 'charging') AS CHARGING,
                COUNT_IF(STATUS = 'error') AS ERROR,
                COUNT_IF(STATUS NOT IN ('moving','charging','error')) AS OTHER,
                ROUND(AVG(BATTERY_PCT), 1) AS AVG_BATTERY,
                COUNT_IF(MAINT_DUE_HRS < 4) AS MAINT_URGENT
         FROM FLEET_INTELLIGENCE.PHARMA_SUPPLY_CHAIN.ROBOT_TELEMETRY
         WHERE PLANT_ID = ${plantId}
         GROUP BY BUILDING_ROLE, BUILDING_ROLE_NAME, FLOOR_INDEX, ROBOT_TYPE, ROBOT_TYPE_LABEL
         ORDER BY BUILDING_ROLE, FLOOR_INDEX, ROBOT_TYPE`,
        'FLEET_INTELLIGENCE', 'PHARMA_SUPPLY_CHAIN'));
      res.json(rows);
    } catch (err: any) { res.status(500).json({ error: err.message }); }
  });

  return router;
}

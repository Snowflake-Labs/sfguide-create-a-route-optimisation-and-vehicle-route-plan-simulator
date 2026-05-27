import { Router } from 'express';

type RunSql = (sql: string, database?: string, schema?: string) => Promise<any[]>;

const up = (rows: any[]) => rows.map(row => {
  const r: Record<string, any> = {};
  for (const [k, v] of Object.entries(row)) r[k.toUpperCase()] = v;
  return r;
});

// ─── Warehouse floor plan generator ───────────────────────────────────────────

interface LatLon { lat: number; lon: number; }
interface Zone {
  id: string; name: string; type: string;
  polygon: [number, number][];
  elevation: number;
  alertStatus: 'critical' | 'warning' | 'ok';
  temperature: number; targetTemp: number | null;
  humidity: number;
  color: [number, number, number, number];
  inventory: { name: string; expiryDate: string; daysLeft: number; status: 'critical' | 'warning' | 'ok' }[];
}
interface Sensor {
  id: string; name: string; zoneId: string;
  position: [number, number];
  type: 'temperature' | 'humidity' | 'co2' | 'motion';
  value: number; unit: string;
  status: 'critical' | 'warning' | 'ok';
  alert: string | null;
}

function getBuildingBBox(geojson: any): { minLon: number; maxLon: number; minLat: number; maxLat: number } | null {
  const coords: [number, number][] = [];
  const extract = (c: any) => {
    if (typeof c[0] === 'number') { coords.push(c as [number, number]); }
    else c.forEach(extract);
  };
  try {
    if (geojson.type === 'Polygon') extract(geojson.coordinates);
    else if (geojson.type === 'MultiPolygon') geojson.coordinates.forEach((p: any) => extract(p));
    else return null;
  } catch { return null; }
  if (coords.length === 0) return null;
  return {
    minLon: Math.min(...coords.map(c => c[0])), maxLon: Math.max(...coords.map(c => c[0])),
    minLat: Math.min(...coords.map(c => c[1])), maxLat: Math.max(...coords.map(c => c[1])),
  };
}

function lerp(a: number, b: number, t: number) { return a + (b - a) * t; }
function rect(minLon: number, maxLon: number, minLat: number, maxLat: number): [number, number][] {
  return [[minLon, minLat], [maxLon, minLat], [maxLon, maxLat], [minLon, maxLat], [minLon, minLat]];
}

function seededRng(seed: number) {
  let s = seed;
  return (n = 1) => { s = (s * 1664525 + 1013904223) & 0xffffffff; return ((s >>> 0) / 0xffffffff) * n; };
}

const ZONE_DEFINITIONS = [
  { id: 'cold_a', name: 'Cold Storage −20°C', type: 'cold_freeze', elevation: 9, targetTemp: -20, baseColor: [59, 130, 246] as [number,number,number] },
  { id: 'cold_b', name: 'Cold Storage +4°C',  type: 'cold_chill',  elevation: 7, targetTemp: 4,   baseColor: [6, 182, 212] as [number,number,number] },
  { id: 'ctrl',   name: 'Controlled Substances', type: 'controlled', elevation: 6, targetTemp: 18, baseColor: [139, 92, 246] as [number,number,number] },
  { id: 'prod',   name: 'Production Floor',   type: 'production', elevation: 12, targetTemp: null, baseColor: [107, 114, 128] as [number,number,number] },
  { id: 'qc',     name: 'QC Laboratory',      type: 'qc',         elevation: 5, targetTemp: 20,  baseColor: [234, 179, 8] as [number,number,number] },
  { id: 'dock',   name: 'Loading Dock',        type: 'dock',       elevation: 4, targetTemp: null, baseColor: [180, 83, 9] as [number,number,number] },
  { id: 'gen',    name: 'General Warehouse',   type: 'general',    elevation: 6, targetTemp: null, baseColor: [75, 85, 99] as [number,number,number] },
];

// Layout: divide bbox into a 2-column, 4-row grid
//   Row 0: col0=cold_a (40%), col1=cold_b (60%)
//   Row 1: col0+col1=prod (100%)
//   Row 2: col0=ctrl (40%), col1=qc (60%)
//   Row 3: col0=dock (40%), col1=gen (60%)
function buildZones(bbox: ReturnType<typeof getBuildingBBox>, plantId: number, areaSqm: number): Zone[] {
  if (!bbox) return [];
  const rng = seededRng(plantId * 7919);
  const { minLon, maxLon, minLat, maxLat } = bbox;
  const split = 0.42;
  const rowH = [0.23, 0.32, 0.22, 0.23]; // fractions of total height
  let y0 = maxLat; // start from top

  const inventoryTemplates: Record<string, string[]> = {
    cold_freeze: ['Insulin Glargine (Lantus)', 'Adalimumab (Humira)', 'Semaglutide (Ozempic)', 'Nitroglycerin Sublingual', 'Biologic Vials'],
    cold_chill:  ['Budesonide Nebulizer', 'Warfarin 5mg', 'Clopidogrel 75mg', 'Insulin Lispro', 'Methotrexate'],
    controlled:  ['Tramadol 50mg', 'Pregabalin 75mg', 'Oxycodone 10mg', 'Fentanyl Patches', 'Diazepam 5mg'],
    qc:          ['In-QC: Batch B-2447', 'Sample: Paracetamol 500mg', 'Pending: Atorvastatin 20mg'],
    production:  [], dock: [], general: ['Albuterol Inhaler', 'Prednisone 10mg', 'Lisinopril 10mg', 'Amlodipine 5mg'],
  };

  const zones: Zone[] = [];
  ZONE_DEFINITIONS.forEach((def, i) => {
    let zoneBbox: { minLon: number; maxLon: number; minLat: number; maxLat: number };
    const r = rowH[Math.min(i, rowH.length - 1)];
    const rowY0 = y0;
    const rowY1 = y0 - (maxLat - minLat) * r;
    const splitLon = lerp(minLon, maxLon, split);

    if (def.id === 'cold_a')  { y0 = rowY1; zoneBbox = { minLon, maxLon: splitLon, minLat: rowY1, maxLat: rowY0 }; }
    else if (def.id === 'cold_b') { zoneBbox = { minLon: splitLon, maxLon, minLat: rowY1, maxLat: rowY0 }; }
    else if (def.id === 'prod') {
      y0 = rowY1;
      const ry0 = rowY0;
      const ry1 = rowY0 - (maxLat - minLat) * rowH[1];
      y0 = ry1;
      zoneBbox = { minLon, maxLon, minLat: ry1, maxLat: ry0 };
    }
    else if (def.id === 'ctrl') {
      y0 = y0 - (maxLat - minLat) * rowH[2];
      zoneBbox = { minLon, maxLon: splitLon, minLat: y0, maxLat: y0 + (maxLat - minLat) * rowH[2] };
    }
    else if (def.id === 'qc') {
      const ry1 = y0 + (maxLat - minLat) * rowH[2];
      zoneBbox = { minLon: splitLon, maxLon, minLat: y0, maxLat: ry1 };
    }
    else if (def.id === 'dock') {
      y0 = y0 - (maxLat - minLat) * rowH[3];
      zoneBbox = { minLon, maxLon: splitLon, minLat: y0, maxLat: y0 + (maxLat - minLat) * rowH[3] };
    }
    else {
      const ry1 = y0 + (maxLat - minLat) * rowH[3];
      zoneBbox = { minLon: splitLon, maxLon, minLat: y0, maxLat: ry1 };
    }

    // Generate synthetic conditions
    const deviation = (rng() - 0.5) * 4;
    const actualTemp = def.targetTemp != null ? def.targetTemp + deviation : 18 + rng() * 6;
    const humidity = 40 + rng() * 35;

    let alertStatus: 'critical' | 'warning' | 'ok' = 'ok';
    if (def.targetTemp != null) {
      const diff = Math.abs(actualTemp - def.targetTemp);
      if (diff > 3) alertStatus = 'critical';
      else if (diff > 1.5) alertStatus = 'warning';
    }
    // Seeded override to give a mix: plantId picks specific zones for alerts
    if ((plantId + i) % 7 === 0) alertStatus = 'critical';
    else if ((plantId + i) % 4 === 0) alertStatus = 'warning';

    const alertAlpha = alertStatus === 'critical' ? 200 : alertStatus === 'warning' ? 180 : 160;
    const color: [number, number, number, number] = alertStatus === 'critical'
      ? [239, 68, 68, alertAlpha]
      : alertStatus === 'warning'
      ? [249, 115, 22, alertAlpha]
      : [...def.baseColor, alertAlpha] as [number, number, number, number];

    // Generate inventory items with expiry
    const invList = inventoryTemplates[def.type] || [];
    const inventory = invList.slice(0, 3).map((name, j) => {
      const daysLeft = Math.round(5 + rng() * 340);
      return {
        name,
        expiryDate: new Date(Date.now() + daysLeft * 86400000).toISOString().slice(0, 10),
        daysLeft,
        status: (daysLeft < 30 ? 'critical' : daysLeft < 90 ? 'warning' : 'ok') as 'critical' | 'warning' | 'ok',
      };
    });

    zones.push({
      id: def.id,
      name: def.name,
      type: def.type,
      polygon: rect(zoneBbox.minLon, zoneBbox.maxLon, zoneBbox.minLat, zoneBbox.maxLat),
      elevation: def.elevation,
      alertStatus,
      temperature: Math.round(actualTemp * 10) / 10,
      targetTemp: def.targetTemp,
      humidity: Math.round(humidity * 10) / 10,
      color,
      inventory,
    });
  });
  return zones;
}

function buildSensors(zones: Zone[], bbox: ReturnType<typeof getBuildingBBox>, plantId: number): Sensor[] {
  if (!bbox) return [];
  const rng = seededRng(plantId * 31337);
  const sensorTypes: Array<{ type: Sensor['type']; unit: string; label: string }> = [
    { type: 'temperature', unit: '°C', label: 'Temp' },
    { type: 'humidity', unit: '%', label: 'RH' },
    { type: 'co2', unit: 'ppm', label: 'CO₂' },
  ];
  const sensors: Sensor[] = [];
  const targetZones = zones.filter(z => ['cold_a', 'cold_b', 'ctrl', 'qc', 'prod'].includes(z.id));
  targetZones.forEach(zone => {
    // Place 2 sensors per zone
    [0.35, 0.65].forEach((t, si) => {
      const coords = zone.polygon;
      const minLon = Math.min(...coords.map(c => c[0]));
      const maxLon = Math.max(...coords.map(c => c[0]));
      const minLat = Math.min(...coords.map(c => c[1]));
      const maxLat = Math.max(...coords.map(c => c[1]));
      const sLon = lerp(minLon, maxLon, t + (rng() - 0.5) * 0.1);
      const sLat = lerp(minLat, maxLat, 0.3 + (rng() * 0.4));
      const st = sensorTypes[si % sensorTypes.length];
      let value: number, status: Sensor['status'], alert: string | null = null;
      if (st.type === 'temperature') {
        value = Math.round((zone.temperature + (rng() - 0.5) * 1.5) * 10) / 10;
        const diff = zone.targetTemp != null ? Math.abs(value - zone.targetTemp) : 0;
        status = diff > 3 ? 'critical' : diff > 1.5 ? 'warning' : 'ok';
        if (status !== 'ok') alert = `Temp ${value}${st.unit} (target ${zone.targetTemp}${st.unit})`;
      } else if (st.type === 'humidity') {
        value = Math.round((zone.humidity + (rng() - 0.5) * 5) * 10) / 10;
        status = value > 80 ? 'warning' : 'ok';
        if (status !== 'ok') alert = `High humidity: ${value}%`;
      } else {
        value = Math.round(400 + rng() * 600);
        status = value > 800 ? 'warning' : 'ok';
        if (status !== 'ok') alert = `Elevated CO₂: ${value}ppm`;
      }
      sensors.push({
        id: `${zone.id}_s${si + 1}`,
        name: `${st.label} Sensor ${zone.id.toUpperCase()}-${si + 1}`,
        zoneId: zone.id,
        position: [sLon, sLat],
        type: st.type, value, unit: st.unit, status, alert,
      });
    });
  });
  return sensors;
}

function buildTimeline(plantId: number): any[] {
  const rng = seededRng(plantId * 99991);
  const now = new Date();
  return Array.from({ length: 24 }, (_, h) => {
    const hour = (now.getHours() - 23 + h + 24) % 24;
    const label = `${String(hour).padStart(2, '0')}:00`;
    const coldA = -20 + (rng() - 0.5) * 5;
    const coldB = 4 + (rng() - 0.5) * 3;
    const ctrl = 18 + (rng() - 0.5) * 4;
    const humidity = 55 + (rng() - 0.5) * 20;
    const co2 = 500 + rng() * 400;
    return {
      hour: label,
      'Cold A (°C)': Math.round(coldA * 10) / 10,
      'Cold B (°C)': Math.round(coldB * 10) / 10,
      'Controlled (°C)': Math.round(ctrl * 10) / 10,
      'Humidity (%)': Math.round(humidity * 10) / 10,
      'CO₂ (ppm)': Math.round(co2),
    };
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
           ORDER BY PLANT_ID`,
          'FLEET_INTELLIGENCE', 'PHARMA_SUPPLY_CHAIN'
        ));
      } catch {
        rows = up(await runSql(
          `SELECT PLANT_ID, PLANT_NAME, PLANT_CODE, CITY, COUNTRY, REGION,
                  SPECIALISATION, CAPACITY_BATCHES_MONTH, LATITUDE, LONGITUDE,
                  0 AS MAX_SEVERITY, 0 AS BATCH_SEVERITY, 0 AS TEMP_SEVERITY,
                  0 AS STOCK_SEVERITY, 0 AS SHIPMENT_SEVERITY,
                  0 AS CRITICAL_BATCHES, 0 AS TEMP_EXCURSIONS,
                  0 AS CRITICAL_STOCK_ITEMS, 0 AS DELAYED_SHIPMENTS, 0 AS BATCHES_IN_PROGRESS
           FROM FLEET_INTELLIGENCE.PHARMA_SUPPLY_CHAIN.PLANTS
           ORDER BY PLANT_ID`,
          'FLEET_INTELLIGENCE', 'PHARMA_SUPPLY_CHAIN'
        ));
      }
      res.json(Array.isArray(rows) ? rows : []);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  router.get('/buildings', async (req, res) => {
    try {
      const plantId = parseInt(req.query.plant_id as string, 10);
      if (isNaN(plantId) || plantId < 1) return res.status(400).json({ error: 'Valid plant_id required' });

      // Use PLANT_PRIMARY_BUILDING view — returns the single largest building per plant
      const rows = up(await runSql(
        `SELECT OVERTURE_ID, GEOJSON, BUILDING_NAME, CLASS, HEIGHT, FOOTPRINT_TYPE, AREA_SQM
         FROM FLEET_INTELLIGENCE.PHARMA_SUPPLY_CHAIN.PLANT_PRIMARY_BUILDING
         WHERE PLANT_ID = ${plantId} AND GEOJSON IS NOT NULL`,
        'FLEET_INTELLIGENCE', 'PHARMA_SUPPLY_CHAIN'
      ));
      const features = rows.map((r: any) => {
        let geometry: any = null;
        try { geometry = typeof r.GEOJSON === 'string' ? JSON.parse(r.GEOJSON) : r.GEOJSON; } catch {}
        return {
          type: 'Feature',
          geometry,
          properties: {
            id:     r.OVERTURE_ID,
            name:   r.BUILDING_NAME || null,
            class:  r.CLASS || null,
            height: r.HEIGHT ? Number(r.HEIGHT) : 12,
            type:   r.FOOTPRINT_TYPE,
            area_sqm: r.AREA_SQM ? Number(r.AREA_SQM) : null,
            is_plant_building: true,
          }
        };
      }).filter((f: any) => f.geometry !== null);
      res.json({ type: 'FeatureCollection', features });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  router.get('/warehouse', async (req, res) => {
    try {
      const plantId = parseInt(req.query.plant_id as string, 10);
      if (isNaN(plantId) || plantId < 1) return res.status(400).json({ error: 'Valid plant_id required' });

      // Fetch the primary building GeoJSON to derive the bounding box
      const rows = up(await runSql(
        `SELECT GEOJSON, AREA_SQM FROM FLEET_INTELLIGENCE.PHARMA_SUPPLY_CHAIN.PLANT_PRIMARY_BUILDING
         WHERE PLANT_ID = ${plantId} AND GEOJSON IS NOT NULL LIMIT 1`,
        'FLEET_INTELLIGENCE', 'PHARMA_SUPPLY_CHAIN'
      ));
      if (!rows.length) return res.status(404).json({ error: 'No primary building found for this plant' });

      let geojson: any = null;
      try { geojson = typeof rows[0].GEOJSON === 'string' ? JSON.parse(rows[0].GEOJSON) : rows[0].GEOJSON; } catch {}
      const areaSqm = rows[0].AREA_SQM ? Number(rows[0].AREA_SQM) : 10000;
      const bbox = getBuildingBBox(geojson);
      if (!bbox) return res.status(422).json({ error: 'Could not parse building bounding box' });

      const zones = buildZones(bbox, plantId, areaSqm);
      const sensors = buildSensors(zones, bbox, plantId);
      const sensorTimeline = buildTimeline(plantId);

      res.json({ zones, sensors, sensorTimeline, bbox, areaSqm });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  router.get('/batches', async (req, res) => {
    try {
      const plantId = parseInt(req.query.plant_id as string, 10);
      if (isNaN(plantId)) return res.status(400).json({ error: 'Valid plant_id required' });
      const rows = up(await runSql(
        `SELECT b.BATCH_NUMBER, pr.PRODUCT_NAME, pr.BUSINESS_LINE,
                b.STATUS, b.QC_RESULT, b.YIELD_PCT,
                b.DEVIATION_COUNT, b.DEVIATION_SEVERITY,
                TO_CHAR(b.PLANNED_COMPLETE, 'YYYY-MM-DD') AS PLANNED_COMPLETE,
                ROUND(b.COST_USD / 1000000, 2) AS COST_USD_M
         FROM FLEET_INTELLIGENCE.PHARMA_SUPPLY_CHAIN.PRODUCTION_BATCHES b
         JOIN FLEET_INTELLIGENCE.PHARMA_SUPPLY_CHAIN.PRODUCTS pr ON pr.PRODUCT_ID = b.PRODUCT_ID
         WHERE b.PLANT_ID = ${plantId}
         ORDER BY
           CASE b.STATUS WHEN 'ON_HOLD' THEN 1 WHEN 'REJECTED' THEN 2
                         WHEN 'QC_REVIEW' THEN 3 WHEN 'IN_PROGRESS' THEN 4 ELSE 5 END`,
        'FLEET_INTELLIGENCE', 'PHARMA_SUPPLY_CHAIN'
      ));
      res.json(rows);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  router.get('/inventory', async (req, res) => {
    try {
      const plantId = parseInt(req.query.plant_id as string, 10);
      if (isNaN(plantId)) return res.status(400).json({ error: 'Valid plant_id required' });
      const rows = up(await runSql(
        `SELECT pr.PRODUCT_NAME, pr.BUSINESS_LINE,
                mi.MATERIAL_TYPE, mi.STOCK_KG, mi.SAFETY_STOCK_KG,
                mi.DAYS_OF_COVERAGE, mi.STOCK_STATUS,
                mi.TEMP_EXCURSION_FLAG,
                TO_CHAR(mi.EXPIRY_DATE, 'YYYY-MM-DD') AS EXPIRY_DATE
         FROM FLEET_INTELLIGENCE.PHARMA_SUPPLY_CHAIN.MATERIAL_INVENTORY mi
         JOIN FLEET_INTELLIGENCE.PHARMA_SUPPLY_CHAIN.PRODUCTS pr ON pr.PRODUCT_ID = mi.PRODUCT_ID
         WHERE mi.PLANT_ID = ${plantId}
         ORDER BY
           CASE mi.STOCK_STATUS WHEN 'CRITICAL' THEN 1 WHEN 'LOW' THEN 2 ELSE 3 END,
           mi.TEMP_EXCURSION_FLAG DESC`,
        'FLEET_INTELLIGENCE', 'PHARMA_SUPPLY_CHAIN'
      ));
      res.json(rows);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  return router;
}

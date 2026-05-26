import { Router } from 'express';

type RunSql = (sql: string, database?: string, schema?: string) => Promise<any[]>;

const up = (rows: any[]) => rows.map(row => {
  const r: Record<string, any> = {};
  for (const [k, v] of Object.entries(row)) r[k.toUpperCase()] = v;
  return r;
});

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
        // Fallback: alert view not yet created — return plants with zero severity
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
      if (isNaN(plantId) || plantId < 1) {
        return res.status(400).json({ error: 'Valid plant_id required' });
      }
      const rows = up(await runSql(
        `SELECT OVERTURE_ID, GEOJSON, BUILDING_NAME, CLASS, HEIGHT, FOOTPRINT_TYPE
         FROM FLEET_INTELLIGENCE.PHARMA_SUPPLY_CHAIN.PLANT_BUILDING_FOOTPRINTS
         WHERE PLANT_ID = ${plantId}
           AND GEOJSON IS NOT NULL`,
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
            height: r.HEIGHT ? Number(r.HEIGHT) : 8,
            type:   r.FOOTPRINT_TYPE
          }
        };
      }).filter((f: any) => f.geometry !== null);
      res.json({ type: 'FeatureCollection', features });
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

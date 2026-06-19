import type { PageSpec } from '../spec-types';

// Declarative conversion of components/dwell/CongestionMap.tsx (Tier 2, H3 map).
// The original exposes an hour-of-day slider (local UI state); the declarative
// area set does not yet include a slider widget, so this renders the page's
// default hour (19:00). A slider area is a planned follow-up. Data + hexagon
// layer otherwise mirror the original (DT_H3_CONGESTION, DWELL_COUNT-scaled
// color, extruded by count).
export const congestionMapSpec: PageSpec = {
  id: 'dwell:congestion',
  label: 'Congestion Map',
  description: 'H3 dwell-density hexagons (default hour 19:00)',
  defaultDatabase: 'FLEET_INTELLIGENCE',
  defaultSchema: 'DWELL_ANALYSIS',
  layout: {
    default: {
      columns: '1fr',
      rows: '1fr',
      grid: `"map"`,
    },
  },
  areas: {
    map: {
      component: 'Map',
      noPad: true,
      layers: [
        {
          type: 'h3',
          hexColumn: 'H3_INDEX',
          valueColumn: 'DWELL_COUNT',
          extruded: true,
          colorScale: [
            [1, 152, 189, 200],
            [209, 55, 78, 200],
          ],
          pickable: true,
          tooltip: '<b>{H3_INDEX}</b><br/>Dwells: {DWELL_COUNT}<br/>Avg: {AVG_DWELL_MIN} min',
          data: {
            query: `SELECT H3_CELL_R7 AS H3_INDEX, SUM(SESSION_COUNT) AS DWELL_COUNT, ROUND(AVG(AVG_DWELL_MIN),1) AS AVG_DWELL_MIN
                    FROM DT_H3_CONGESTION
                    WHERE EXTRACT(HOUR FROM HOUR_BUCKET) = 19
                    GROUP BY H3_CELL_R7 LIMIT 5000`,
            refetchOn: ['region', 'vehicle'],
          },
        },
      ],
    },
  },
};

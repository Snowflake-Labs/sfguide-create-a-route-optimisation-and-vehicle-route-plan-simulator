import type { PageSpec } from '../spec-types';

// Declarative conversion of components/dwell/DwellOverview.tsx (Tier 1).
// SQL mirrors the original queries; the trends query reverses to ascending and
// formats the day as MM-DD in SQL (the original did this in JS) so the line
// chart renders identically without a client-side transform.
export const dwellOverviewSpec: PageSpec = {
  id: 'dwell:overview',
  label: 'Dwell Analysis Overview',
  description: 'Fleet dwell time analytics and SLA monitoring',
  defaultDatabase: 'FLEET_INTELLIGENCE',
  defaultSchema: 'DWELL_ANALYSIS',
  layout: {
    default: {
      columns: '1fr 1fr',
      rows: 'auto 1fr',
      grid: `
        "metrics metrics"
        "trends  facilities"
      `,
    },
  },
  areas: {
    metrics: {
      component: 'MetricCards',
      data: {
        query: `SELECT COUNT(DISTINCT SESSION_ID) AS TOTAL_TRIPS,
                       ROUND(AVG(DWELL_MINUTES),1) AS AVG_DWELL,
                       ROUND(SUM(CASE WHEN DWELL_MINUTES <= 30 THEN 1 ELSE 0 END)*100.0/NULLIF(COUNT(*),0),1) AS SLA_PCT,
                       COUNT(DISTINCT VEHICLE_ID) AS ACTIVE_DRIVERS
                FROM DT_DWELL_ENRICHED`,
        refetchOn: ['region', 'vehicle'],
      },
      mapping: {
        metrics: [
          { column: 'TOTAL_TRIPS', label: 'Total Trips', format: 'number' },
          { column: 'AVG_DWELL', label: 'Avg Dwell Time', format: 'decimal', suffix: ' min' },
          { column: 'SLA_PCT', label: 'SLA Compliance', format: 'percent' },
          { column: 'ACTIVE_DRIVERS', label: 'Active Drivers', format: 'number' },
        ],
      },
    },
    trends: {
      component: 'Chart',
      title: 'Daily Trends (Last 30 Days)',
      data: {
        query: `SELECT SUBSTR(TO_VARCHAR(TREND_DATE),6) AS DAY, TOTAL_DWELLS, TOTAL_TRIPS FROM (
                  SELECT TREND_DATE, TOTAL_SESSIONS AS TOTAL_DWELLS, ACTIVE_VEHICLES AS TOTAL_TRIPS
                  FROM DT_DAILY_TRENDS ORDER BY TREND_DATE DESC LIMIT 30
                ) ORDER BY TREND_DATE ASC`,
        refetchOn: ['region', 'vehicle'],
      },
      config: {
        chartType: 'line',
        xKey: 'DAY',
        series: [
          { dataKey: 'TOTAL_DWELLS', label: 'Dwells', color: '#29B5E8' },
          { dataKey: 'TOTAL_TRIPS', label: 'Trips', color: '#FF6B35' },
        ],
      },
    },
    facilities: {
      component: 'Chart',
      title: 'Top 10 Facilities by Visits',
      data: {
        query: `SELECT SUBSTR(LOCATION_NAME,1,20) AS FACILITY_NAME, SUM(TOTAL_SESSIONS) AS TOTAL_VISITS
                FROM DT_FACILITY_UTILIZATION GROUP BY LOCATION_NAME ORDER BY TOTAL_VISITS DESC LIMIT 10`,
        refetchOn: ['region', 'vehicle'],
      },
      config: {
        chartType: 'bar',
        orientation: 'vertical',
        xKey: 'FACILITY_NAME',
        series: [{ dataKey: 'TOTAL_VISITS', label: 'Visits' }],
      },
    },
  },
};

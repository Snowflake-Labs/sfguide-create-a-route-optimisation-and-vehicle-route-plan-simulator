import React, { lazy, Suspense } from 'react';

const PAGE_COMPONENTS: Record<string, React.LazyExoticComponent<React.ComponentType<any>>> = {
  'route-optimization': lazy(() => import('../pages/route-optimization/RouteOptimization')),
  'dwell-overview': lazy(() => import('../pages/dwell-analysis/Overview')),
  'dwell-congestion': lazy(() => import('../pages/dwell-analysis/CongestionMap')),
  'dwell-facility': lazy(() => import('../pages/dwell-analysis/FacilityUtilization')),
  'dwell-sla': lazy(() => import('../pages/dwell-analysis/SLAAlerts')),
  'dwell-trips': lazy(() => import('../pages/dwell-analysis/TripInspector')),
  'dwell-drivers': lazy(() => import('../pages/dwell-analysis/DriverPerformance')),
  'dwell-live': lazy(() => import('../pages/dwell-analysis/LiveOperations')),
  'retail-catchment': lazy(() => import('../pages/retail-catchment/RetailCatchment')),
  'fleet-taxis-overview': lazy(() => import('../pages/fleet-taxis/FleetOverview')),
  'fleet-taxis-drivers': lazy(() => import('../pages/fleet-taxis/DriverRoutes')),
  'fleet-taxis-heatmap': lazy(() => import('../pages/fleet-taxis/HeatMap')),
  'fleet-delivery-map': lazy(() => import('../pages/fleet-delivery/FleetMap')),
  'fleet-delivery-builder': lazy(() => import('../pages/fleet-delivery/DataBuilder')),
  'fleet-delivery-matrix': lazy(() => import('../pages/fleet-delivery/MatrixBuilder')),
  'fleet-delivery-catchment': lazy(() => import('../pages/fleet-delivery/CatchmentPanel')),
  'route-deviation-dashboard': lazy(() => import('../pages/route-deviation/DeviationDashboard')),
  'route-deviation-compare': lazy(() => import('../pages/route-deviation/RouteComparison')),
  'route-deviation-inspector': lazy(() => import('../pages/route-deviation/RouteInspector')),
  'routing-agent': lazy(() => import('../pages/routing-agent/AgentPlayground')),
  'travel-time-matrix': lazy(() => import('../pages/travel-time-matrix/TravelTimeExplorer')),
  'data-studio': lazy(() => import('../pages/data-studio/FleetDataStudio')),
};

interface PageRegistryProps {
  pageId: string;
  demo: { source_db: string; source_schema: string; config: Record<string, any> };
}

export default function PageRegistry({ pageId, demo }: PageRegistryProps) {
  const Component = PAGE_COMPONENTS[pageId];
  if (!Component) {
    return <div className="page-not-found">Page component not found: {pageId}</div>;
  }
  return (
    <Suspense fallback={<div className="page-loading"><div className="spinner" /></div>}>
      <Component sourceDb={demo.source_db} sourceSchema={demo.source_schema} config={demo.config} />
    </Suspense>
  );
}

import { Clock, Truck, CarTaxiFront, GitBranch, Route, Store, Bot, Database, Activity, MapPin, Grid3X3, Eye, Wrench } from 'lucide-react';

type CoreTab = 'services' | 'cities' | 'matrix' | 'viewer' | 'functions' | 'travel-time' | 'dwell' | 'fleet-delivery' | 'fleet-taxis' | 'route-deviation' | 'route-opt' | 'retail' | 'agent' | 'studio';

interface Props {
  onNavigate: (tab: CoreTab) => void;
}

const DEMOS: { key: CoreTab; label: string; desc: string; icon: React.ComponentType<any> }[] = [
  { key: 'travel-time', label: 'Travel Time', desc: 'H3 travel-time matrix visualization and isochrone explorer', icon: Clock },
  { key: 'dwell', label: 'Dwell Analysis', desc: 'Analyze stop durations, idle time, and dwell patterns across fleet', icon: Clock },
  { key: 'fleet-delivery', label: 'Fleet Delivery', desc: 'Food delivery fleet operations, catchment areas, and matrix analysis', icon: Truck },
  { key: 'fleet-taxis', label: 'Fleet Taxis', desc: 'Taxi fleet overview, driver routes, and demand heatmaps', icon: CarTaxiFront },
  { key: 'route-deviation', label: 'Route Deviation', desc: 'Compare planned vs actual routes and inspect deviations', icon: GitBranch },
  { key: 'route-opt', label: 'Route Optimization', desc: 'Vehicle routing problem solver with capacity and time windows', icon: Route },
  { key: 'retail', label: 'Retail Catchment', desc: 'Drive-time catchment areas and competitor proximity analysis', icon: Store },
  { key: 'agent', label: 'Routing Agent', desc: 'AI-powered routing assistant with natural language queries', icon: Bot },
  { key: 'studio', label: 'Data Studio', desc: 'Fleet data exploration and synthetic dataset configuration', icon: Database },
];

const ADMIN: { key: CoreTab; label: string; desc: string; icon: React.ComponentType<any> }[] = [
  { key: 'services', label: 'Status', desc: 'Monitor compute pool, ORS health, and service readiness', icon: Activity },
  { key: 'cities', label: 'City Builder', desc: 'Provision new cities, manage routing profiles and map data', icon: MapPin },
  { key: 'matrix', label: 'Matrix Builder', desc: 'Build H3 travel-time matrices with cost and time estimates', icon: Grid3X3 },
  { key: 'viewer', label: 'Matrix Viewer', desc: 'Visualize travel-time matrices on an interactive map', icon: Eye },
  { key: 'functions', label: 'Functions', desc: 'Test native app SQL functions with live map preview', icon: Wrench },
];

export default function Home({ onNavigate }: Props) {
  return (
    <div>
      <h2 style={{ fontSize: 22, marginBottom: 4 }}>Routing Service</h2>
      <p style={{ color: 'var(--text-secondary)', fontSize: 13, marginBottom: 24 }}>
        OpenRouteService on Snowflake — geospatial routing, optimization, and fleet analytics
      </p>

      <h3 style={{ fontSize: 11, color: 'var(--text-secondary)', textTransform: 'uppercase', letterSpacing: 0.8, marginBottom: 12 }}>Demos</h3>
      <div className="home-grid" style={{ marginBottom: 32 }}>
        {DEMOS.map(d => (
          <button key={d.key} className="home-card" onClick={() => onNavigate(d.key)}>
            <d.icon size={24} className="home-card-icon" />
            <h3>{d.label}</h3>
            <p>{d.desc}</p>
          </button>
        ))}
      </div>

      <h3 style={{ fontSize: 11, color: 'var(--text-secondary)', textTransform: 'uppercase', letterSpacing: 0.8, marginBottom: 12 }}>Admin</h3>
      <div className="home-grid">
        {ADMIN.map(d => (
          <button key={d.key} className="home-card" onClick={() => onNavigate(d.key)}>
            <d.icon size={24} className="home-card-icon" />
            <h3>{d.label}</h3>
            <p>{d.desc}</p>
          </button>
        ))}
      </div>
    </div>
  );
}

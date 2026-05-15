import { Info, Activity, MapPin, Wrench, Grid3X3, Database, Route, Clock, Truck, CarTaxiFront, GitBranch, Store, Bot } from 'lucide-react';

interface Props {
  onNavigate: (tab: string) => void;
}

const GETTING_STARTED: { key: string; label: string; desc: string; icon: React.ComponentType<any> }[] = [
  { key: 'about', label: 'About', desc: 'Architecture, purpose, and how to work with this platform', icon: Info },
  { key: 'services', label: 'Status & Health', desc: 'Monitor compute pool, ORS health, and service readiness', icon: Activity },
];

const CORE: { key: string; label: string; desc: string; icon: React.ComponentType<any> }[] = [
  { key: 'regions', label: 'Region Builder', desc: 'Configure geographies, download map data, manage routing profiles', icon: MapPin },
  { key: 'functions', label: 'Directions & Isochrones', desc: 'Test routing SQL functions with live map preview', icon: Wrench },
  { key: 'matrix:builder', label: 'Travel Matrix', desc: 'Build and view H3 travel-time matrices for analytical queries', icon: Grid3X3 },
  { key: 'studio', label: 'Data Studio', desc: 'Generate synthetic fleet telemetry for testing and development', icon: Database },
  { key: 'route-opt', label: 'Route Optimizer (VRP)', desc: 'Vehicle routing solver with capacity constraints and time windows', icon: Route },
];

const ACCELERATORS: { key: string; label: string; desc: string; icon: React.ComponentType<any> }[] = [
  { key: 'fleet-taxis:overview', label: 'Fleet Taxis', desc: 'GPS telemetry tracking, driver routes, and demand heatmaps', icon: CarTaxiFront },
  { key: 'fleet-delivery:map', label: 'Fleet Delivery', desc: 'Courier tracking, catchment areas, and delivery analytics', icon: Truck },
  { key: 'dwell:overview', label: 'Dwell & Congestion', desc: 'Dynamic Table pipeline for stop detection, SLA alerts, and congestion', icon: Clock },
  { key: 'route-deviation:dashboard', label: 'Route Deviation', desc: 'Planned vs actual route comparison and detour detection', icon: GitBranch },
  { key: 'retail', label: 'Retail Catchment', desc: 'Drive-time isochrone analysis and competitor proximity mapping', icon: Store },
  { key: 'agent', label: 'Routing Agent', desc: 'Cortex Agent integration for natural language routing queries', icon: Bot },
];

export default function Home({ onNavigate }: Props) {
  return (
    <div>
      <h2 style={{ fontSize: 22, marginBottom: 4 }}>Routing & Fleet Intelligence</h2>
      <p style={{ color: 'var(--text-secondary)', fontSize: 13, marginBottom: 24 }}>
        Geospatial routing, optimization, and fleet analytics powered by OpenRouteService on Snowflake
      </p>

      <h3 style={{ fontSize: 11, color: 'var(--text-secondary)', textTransform: 'uppercase', letterSpacing: 0.8, marginBottom: 12 }}>Getting Started</h3>
      <div className="home-grid" style={{ marginBottom: 32 }}>
        {GETTING_STARTED.map(d => (
          <button key={d.key} className="home-card" onClick={() => onNavigate(d.key)}>
            <d.icon size={24} className="home-card-icon" />
            <h3>{d.label}</h3>
            <p>{d.desc}</p>
          </button>
        ))}
      </div>

      <h3 style={{ fontSize: 11, color: 'var(--text-secondary)', textTransform: 'uppercase', letterSpacing: 0.8, marginBottom: 12 }}>Core Capabilities</h3>
      <div className="home-grid" style={{ marginBottom: 32 }}>
        {CORE.map(d => (
          <button key={d.key} className="home-card" onClick={() => onNavigate(d.key)}>
            <d.icon size={24} className="home-card-icon" />
            <h3>{d.label}</h3>
            <p>{d.desc}</p>
          </button>
        ))}
      </div>

      <h3 style={{ fontSize: 11, color: 'var(--text-secondary)', textTransform: 'uppercase', letterSpacing: 0.8, marginBottom: 12 }}>Solution Accelerators</h3>
      <div className="home-grid">
        {ACCELERATORS.map(d => (
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

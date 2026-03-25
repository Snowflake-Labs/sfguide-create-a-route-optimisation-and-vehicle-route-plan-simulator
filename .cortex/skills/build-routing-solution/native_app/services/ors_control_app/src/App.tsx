import { useState } from 'react';
import { Home as HomeIcon, Clock, Truck, CarTaxiFront, GitBranch, Route, Store, Bot, Database, Activity, MapPin, Grid3X3, Eye, Wrench } from 'lucide-react';
import ServiceManager from './components/ServiceManager';
import CityProvisioner from './components/CityProvisioner';
import MatrixBuilder from './components/MatrixBuilder';
import MatrixViewer from './components/MatrixViewer';
import FunctionTester from './components/FunctionTester';
import { useRegionProvider, RegionContext } from './hooks/useRegion';
import TravelTimeExplorer from './components/TravelTimeExplorer';
import DwellAnalysis from './components/DwellAnalysis';
import FleetDelivery from './components/FleetDelivery';
import FleetTaxis from './components/FleetTaxis';
import RouteDeviation from './components/RouteDeviation';
import RouteOptimization from './components/RouteOptimization';
import RetailCatchment from './components/RetailCatchment';
import AgentPlayground from './components/AgentPlayground';
import FleetDataStudio from './components/FleetDataStudio';
import Home from './components/Home';

type CoreTab = 'home' | 'services' | 'cities' | 'matrix' | 'viewer' | 'functions' | 'travel-time' | 'dwell' | 'fleet-delivery' | 'fleet-taxis' | 'route-deviation' | 'route-opt' | 'retail' | 'agent' | 'studio';

const DEMO_NAV: { key: CoreTab; label: string; icon: React.ComponentType<any> }[] = [
  { key: 'travel-time', label: 'Travel Time', icon: Clock },
  { key: 'dwell', label: 'Dwell Analysis', icon: Clock },
  { key: 'fleet-delivery', label: 'Fleet Delivery', icon: Truck },
  { key: 'fleet-taxis', label: 'Fleet Taxis', icon: CarTaxiFront },
  { key: 'route-deviation', label: 'Route Deviation', icon: GitBranch },
  { key: 'route-opt', label: 'Route Optimization', icon: Route },
  { key: 'retail', label: 'Retail Catchment', icon: Store },
  { key: 'agent', label: 'Routing Agent', icon: Bot },
  { key: 'studio', label: 'Data Studio', icon: Database },
];

const ADMIN_NAV: { key: CoreTab; label: string; icon: React.ComponentType<any> }[] = [
  { key: 'services', label: 'Status', icon: Activity },
  { key: 'cities', label: 'City Builder', icon: MapPin },
  { key: 'matrix', label: 'Matrix Builder', icon: Grid3X3 },
  { key: 'viewer', label: 'Matrix Viewer', icon: Eye },
  { key: 'functions', label: 'Functions', icon: Wrench },
];

const TAB_LABELS: Record<CoreTab, string> = {
  home: 'Home',
  'travel-time': 'Travel Time',
  dwell: 'Dwell Analysis',
  'fleet-delivery': 'Fleet Delivery',
  'fleet-taxis': 'Fleet Taxis',
  'route-deviation': 'Route Deviation',
  'route-opt': 'Route Optimization',
  retail: 'Retail Catchment',
  agent: 'Routing Agent',
  studio: 'Data Studio',
  services: 'Status',
  cities: 'City Builder',
  matrix: 'Matrix Builder',
  viewer: 'Matrix Viewer',
  functions: 'Functions',
};

export default function App() {
  const [activeTab, setActiveTab] = useState<CoreTab>('home');
  const region = useRegionProvider();

  return (
    <RegionContext.Provider value={region.value}>
      <div className="app">
        <aside className="sidebar">
          <div className="sidebar-brand">
            <img src="/snowflake_h3.png" alt="Snowflake" />
            <span>Routing Service</span>
          </div>
          <nav className="sidebar-nav">
            <button className={`sidebar-link${activeTab === 'home' ? ' active' : ''}`} onClick={() => setActiveTab('home')}>
              <HomeIcon size={16} />
              Home
            </button>

            <div className="sidebar-section">Demos</div>
            {DEMO_NAV.map(t => (
              <button key={t.key} className={`sidebar-link${activeTab === t.key ? ' active' : ''}`} onClick={() => setActiveTab(t.key)}>
                <t.icon size={16} />
                {t.label}
              </button>
            ))}

            <div className="sidebar-section">Admin</div>
            {ADMIN_NAV.map(t => (
              <button key={t.key} className={`sidebar-link${activeTab === t.key ? ' active' : ''}`} onClick={() => setActiveTab(t.key)}>
                <t.icon size={16} />
                {t.label}
              </button>
            ))}
          </nav>
          <div className="sidebar-footer">
            <span className="sidebar-version">v1.0.34</span>
          </div>
        </aside>

        <div className="app-content">
          <header className="app-header">
            <span style={{ fontSize: 14, fontWeight: 500, color: 'var(--text)' }}>{TAB_LABELS[activeTab]}</span>
          </header>
          <main className="app-main">
            {activeTab === 'home' && <Home onNavigate={setActiveTab} />}
            {activeTab === 'services' && <ServiceManager />}
            {activeTab === 'cities' && <CityProvisioner />}
            {activeTab === 'matrix' && <MatrixBuilder />}
            {activeTab === 'viewer' && <MatrixViewer />}
            {activeTab === 'functions' && <FunctionTester />}
            {activeTab === 'travel-time' && <TravelTimeExplorer />}
            {activeTab === 'dwell' && <DwellAnalysis />}
            {activeTab === 'fleet-delivery' && <FleetDelivery />}
            {activeTab === 'fleet-taxis' && <FleetTaxis />}
            {activeTab === 'route-deviation' && <RouteDeviation />}
            {activeTab === 'route-opt' && <RouteOptimization />}
            {activeTab === 'retail' && <RetailCatchment />}
            {activeTab === 'agent' && <AgentPlayground />}
            {activeTab === 'studio' && <FleetDataStudio />}
          </main>
        </div>
      </div>
    </RegionContext.Provider>
  );
}

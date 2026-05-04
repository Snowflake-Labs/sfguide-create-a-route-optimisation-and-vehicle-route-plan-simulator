import { useState, useEffect } from 'react';
import { Info, Map, Activity, MapPin, Wrench, Grid3X3, Database, Route, Clock, Truck, CarTaxiFront, GitBranch, Store, Bot, Stethoscope, ChevronDown, ChevronRight } from 'lucide-react';
import ServiceManager from './components/ServiceManager';
import RegionBuilder from './components/RegionBuilder';
import MatrixBuilder from './components/MatrixBuilder';
import MatrixViewer from './components/MatrixViewer';
import FunctionTester from './components/FunctionTester';
import { useRegionProvider, RegionContext } from './hooks/useRegion';
import { useVehicleTypeProvider, VehicleTypeContext } from './hooks/useVehicleType';
import DwellAnalysis from './components/DwellAnalysis';
import FleetDelivery from './components/FleetDelivery';
import FleetTaxis from './components/FleetTaxis';
import RouteDeviation from './components/RouteDeviation';
import RouteOptimization from './components/RouteOptimization';
import RetailCatchment from './components/RetailCatchment';
import AgentPlayground from './components/AgentPlayground';
import FleetDataStudio from './components/FleetDataStudio';
import Diagnostics from './components/Diagnostics';
import About from './components/About';
import Intro from './components/Intro';
import Home from './components/Home';
import RegionSwitcher from './shared/RegionSwitcher';
import VehicleTypeSwitcher from './shared/VehicleTypeSwitcher';

interface SubPage { key: string; label: string; }

interface NavGroup {
  key: string;
  label: string;
  icon: React.ComponentType<any>;
  subPages?: SubPage[];
}

const GETTING_STARTED: NavGroup[] = [
  { key: 'about', label: 'About', icon: Info },
  { key: 'intro', label: 'Intro', icon: Map },
  { key: 'services', label: 'Status & Health', icon: Activity },
];

const CORE_CAPABILITIES: NavGroup[] = [
  { key: 'regions', label: 'Region Builder', icon: MapPin },
  { key: 'functions', label: 'Directions & Isochrones', icon: Wrench },
  { key: 'matrix', label: 'Travel Matrix', icon: Grid3X3, subPages: [
    { key: 'matrix:builder', label: 'Builder' },
    { key: 'matrix:viewer', label: 'Viewer' },
  ]},
  { key: 'studio', label: 'Data Studio', icon: Database },
  { key: 'route-opt', label: 'Route Optimizer (VRP)', icon: Route },
];

const SOLUTION_ACCELERATORS: NavGroup[] = [
  { key: 'fleet-taxis', label: 'Fleet Taxis', icon: CarTaxiFront, subPages: [
    { key: 'fleet-taxis:overview', label: 'Fleet Overview' },
    { key: 'fleet-taxis:routes', label: 'Driver Routes' },
    { key: 'fleet-taxis:heatmap', label: 'Heat Map' },
  ]},
  { key: 'fleet-delivery', label: 'Fleet Delivery', icon: Truck, subPages: [
    { key: 'fleet-delivery:dashboard', label: 'Dashboard' },
    { key: 'fleet-delivery:map', label: 'Fleet Map' },
    { key: 'fleet-delivery:catchment', label: 'Catchment Panel' },
    { key: 'fleet-delivery:heatmap', label: 'Courier Heatmap' },
  ]},
  { key: 'dwell', label: 'Dwell & Congestion', icon: Clock, subPages: [
    { key: 'dwell:overview', label: 'Overview' },
    { key: 'dwell:congestion', label: 'Congestion Map' },
    { key: 'dwell:facilities', label: 'Facility Utilization' },
    { key: 'dwell:sla', label: 'SLA Alerts' },
    { key: 'dwell:trips', label: 'Trip Inspector' },
    { key: 'dwell:drivers', label: 'Driver Performance' },
    { key: 'dwell:live', label: 'Live Operations' },
  ]},
  { key: 'route-deviation', label: 'Route Deviation', icon: GitBranch, subPages: [
    { key: 'route-deviation:dashboard', label: 'Deviation Dashboard' },
    { key: 'route-deviation:comparison', label: 'Route Comparison' },
    { key: 'route-deviation:inspector', label: 'Route Inspector' },
  ]},
  { key: 'retail', label: 'Retail Catchment', icon: Store },
  { key: 'agent', label: 'Routing Agent', icon: Bot },
];

const ADMIN_NAV: NavGroup[] = [
  { key: 'diagnostics', label: 'Diagnostics', icon: Stethoscope },
];

const ALL_SECTIONS = [
  { label: 'Getting Started', items: GETTING_STARTED },
  { label: 'Core Capabilities', items: CORE_CAPABILITIES },
  { label: 'Solution Accelerators', items: SOLUTION_ACCELERATORS },
  { label: 'Admin', items: ADMIN_NAV },
];

function getHeaderLabel(tab: string): string {
  if (tab === 'home') return 'Home';
  for (const section of ALL_SECTIONS) {
    for (const g of section.items) {
      if (tab === g.key) return g.label;
      if (g.subPages) {
        const sp = g.subPages.find(p => p.key === tab);
        if (sp) return `${g.label} / ${sp.label}`;
      }
    }
  }
  return '';
}

export default function App() {
  const [activeTab, setActiveTab] = useState<string>('home');
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [appVersion, setAppVersion] = useState('');
  const region = useRegionProvider();
  const vehicleTypeCtx = useVehicleTypeProvider();

  useEffect(() => {
    fetch('/api/health').then(r => r.json()).then(d => setAppVersion(d.version || '')).catch(() => {});
  }, []);

  const toggleExpand = (groupKey: string) => {
    setExpanded(prev => ({ ...prev, [groupKey]: !prev[groupKey] }));
  };

  const navigateTo = (tab: string) => {
    setActiveTab(tab);
  };

  const activeCategory = activeTab.includes(':') ? activeTab.split(':')[0] : activeTab;
  const activeSubTab = activeTab.includes(':') ? activeTab.split(':')[1] : undefined;

  const FULL_WIDTH_TABS = ['intro', 'dwell', 'fleet-delivery', 'route-deviation', 'retail', 'agent'];
  const isFullWidth = FULL_WIDTH_TABS.includes(activeCategory);

  const renderNavGroup = (g: NavGroup) => {
    const isGroupActive = activeCategory === g.key;
    const isExpanded = expanded[g.key] ?? isGroupActive;

    if (!g.subPages) {
      return (
        <button key={g.key} className={`sidebar-link${isGroupActive ? ' active' : ''}`} onClick={() => navigateTo(g.key)}>
          <g.icon size={16} />
          {g.label}
        </button>
      );
    }

    return (
      <div key={g.key} className="sidebar-group">
        <button
          className={`sidebar-link sidebar-group-toggle${isGroupActive ? ' active' : ''}`}
          onClick={() => toggleExpand(g.key)}
        >
          <g.icon size={16} />
          {g.label}
          {isExpanded ? <ChevronDown size={14} className="chevron" /> : <ChevronRight size={14} className="chevron" />}
        </button>
        {isExpanded && (
          <div className="sidebar-sub-links">
            {g.subPages.map(sp => (
              <button
                key={sp.key}
                className={`sidebar-sub-link${activeTab === sp.key ? ' active' : ''}`}
                onClick={() => navigateTo(sp.key)}
              >
                {sp.label}
              </button>
            ))}
          </div>
        )}
      </div>
    );
  };

  return (
    <RegionContext.Provider value={region.value}>
      <VehicleTypeContext.Provider value={vehicleTypeCtx.value}>
      <div className="app">
        <aside className="sidebar">
          <div className="sidebar-brand">
            <img src="/snowflake_h3.png" alt="Snowflake" />
            <span>Fleet Intelligence</span>
          </div>
          <nav className="sidebar-nav">
            <button className={`sidebar-link${activeTab === 'home' ? ' active' : ''}`} onClick={() => navigateTo('home')}>
              <Activity size={16} />
              Home
            </button>

            {ALL_SECTIONS.map(section => (
              <div key={section.label}>
                <div className="sidebar-section">{section.label}</div>
                {section.items.map(renderNavGroup)}
              </div>
            ))}
          </nav>
          <div className="sidebar-footer">
            <span className="sidebar-version">{appVersion ? `v${appVersion}` : ''}</span>
          </div>
        </aside>

        <div className="app-content">
          <header className="app-header">
            <span style={{ fontSize: 14, fontWeight: 500, color: 'var(--text)' }}>{getHeaderLabel(activeTab)}</span>
            <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center' }}>
              <VehicleTypeSwitcher />
              <RegionSwitcher />
              <button
                onClick={() => {
                  document.cookie.split(';').forEach(c => {
                    document.cookie = c.replace(/^ +/, '').replace(/=.*/, '=;expires=Thu, 01 Jan 1970 00:00:00 UTC;path=/');
                  });
                  window.location.href = '/logout';
                }}
                style={{ fontSize: 11, padding: '4px 10px', border: '1px solid #E5484D', borderRadius: 6, background: 'rgba(229,72,77,0.1)', cursor: 'pointer', color: '#E5484D', fontWeight: 600 }}
                title="Log out and refresh session"
              >⏻ Logout</button>
            </div>
          </header>
          <main className={`app-main${isFullWidth ? ' full-width' : ''}`}>
            {activeTab === 'home' && <Home onNavigate={navigateTo} />}
            {activeTab === 'about' && <About />}
            {activeTab === 'intro' && <Intro />}
            {activeTab === 'services' && <ServiceManager />}
            {activeTab === 'regions' && <RegionBuilder />}
            {activeTab === 'functions' && <FunctionTester />}
            {activeCategory === 'matrix' && !activeSubTab && <MatrixBuilder />}
            {activeTab === 'matrix:builder' && <MatrixBuilder />}
            {activeTab === 'matrix:viewer' && <MatrixViewer />}
            {activeTab === 'studio' && <FleetDataStudio />}
            {activeTab === 'route-opt' && <RouteOptimization />}
            {activeCategory === 'fleet-taxis' && <FleetTaxis subTab={activeSubTab} />}
            {activeCategory === 'fleet-delivery' && <FleetDelivery subTab={activeSubTab} />}
            {activeCategory === 'dwell' && <DwellAnalysis subTab={activeSubTab} />}
            {activeCategory === 'route-deviation' && <RouteDeviation subTab={activeSubTab} />}
            {activeTab === 'retail' && <RetailCatchment />}
            {activeTab === 'agent' && <AgentPlayground />}
            {activeTab === 'diagnostics' && <Diagnostics />}
          </main>
        </div>
      </div>
      </VehicleTypeContext.Provider>
    </RegionContext.Provider>
  );
}

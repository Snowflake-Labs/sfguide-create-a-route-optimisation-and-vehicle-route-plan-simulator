import { useState, useEffect } from 'react';
import { Home as HomeIcon, Map, Clock, Truck, CarTaxiFront, GitBranch, Route, Store, Bot, Database, Activity, MapPin, Grid3X3, Eye, Wrench, Stethoscope, ChevronDown, ChevronRight } from 'lucide-react';
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

const DEMO_GROUPS: NavGroup[] = [
  { key: 'intro', label: 'Intro', icon: Map },
  { key: 'dwell', label: 'Dwell Analysis', icon: Clock, subPages: [
    { key: 'dwell:overview', label: 'Overview' },
    { key: 'dwell:congestion', label: 'Congestion Map' },
    { key: 'dwell:facilities', label: 'Facility Utilization' },
    { key: 'dwell:sla', label: 'SLA Alerts' },
    { key: 'dwell:trips', label: 'Trip Inspector' },
    { key: 'dwell:drivers', label: 'Driver Performance' },
    { key: 'dwell:live', label: 'Live Operations' },
  ]},
  { key: 'fleet-delivery', label: 'Fleet Delivery', icon: Truck, subPages: [
    { key: 'fleet-delivery:dashboard', label: 'Dashboard' },
    { key: 'fleet-delivery:map', label: 'Fleet Map' },
    { key: 'fleet-delivery:catchment', label: 'Catchment Panel' },
    { key: 'fleet-delivery:heatmap', label: 'Courier Heatmap' },
  ]},
  { key: 'fleet-taxis', label: 'Fleet Taxis', icon: CarTaxiFront, subPages: [
    { key: 'fleet-taxis:overview', label: 'Fleet Overview' },
    { key: 'fleet-taxis:routes', label: 'Driver Routes' },
    { key: 'fleet-taxis:heatmap', label: 'Heat Map' },
  ]},
  { key: 'route-opt', label: 'Route Optimization', icon: Route },
  { key: 'retail', label: 'Retail Catchment', icon: Store },
  { key: 'route-deviation', label: 'Route Deviation', icon: GitBranch, subPages: [
    { key: 'route-deviation:dashboard', label: 'Deviation Dashboard' },
    { key: 'route-deviation:comparison', label: 'Route Comparison' },
    { key: 'route-deviation:inspector', label: 'Route Inspector' },
  ]},
  { key: 'agent', label: 'Routing Agent', icon: Bot },
  { key: 'studio', label: 'Data Studio', icon: Database },
];

type AdminTab = 'services' | 'regions' | 'matrix' | 'viewer' | 'functions' | 'diagnostics';

const ADMIN_NAV: { key: AdminTab; label: string; icon: React.ComponentType<any> }[] = [
  { key: 'services', label: 'Status', icon: Activity },
  { key: 'regions', label: 'Region Builder', icon: MapPin },
  { key: 'matrix', label: 'Travel Matrix Builder', icon: Grid3X3 },
  { key: 'viewer', label: 'Travel Matrix Viewer', icon: Eye },
  { key: 'functions', label: 'Functions', icon: Wrench },
  { key: 'diagnostics', label: 'Diagnostics', icon: Stethoscope },
];

function getHeaderLabel(tab: string): string {
  if (tab === 'home') return 'Home';
  for (const g of DEMO_GROUPS) {
    if (tab === g.key) return g.label;
    if (g.subPages) {
      const sp = g.subPages.find(p => p.key === tab);
      if (sp) return `${g.label} — ${sp.label}`;
    }
  }
  const admin = ADMIN_NAV.find(a => a.key === tab);
  if (admin) return admin.label;
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

  const FULL_WIDTH_TABS = ['dwell', 'fleet-delivery', 'route-deviation', 'route-opt', 'retail', 'agent'];
  const isFullWidth = FULL_WIDTH_TABS.includes(activeCategory);

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
              <HomeIcon size={16} />
              Home
            </button>

            <div className="sidebar-section">Demos</div>
            {DEMO_GROUPS.map(g => {
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
            })}

            <div className="sidebar-section">Routing Service</div>
            {ADMIN_NAV.map(t => (
              <button key={t.key} className={`sidebar-link${activeTab === t.key ? ' active' : ''}`} onClick={() => navigateTo(t.key)}>
                <t.icon size={16} />
                {t.label}
              </button>
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
                onClick={() => { window.location.href = '/logout'; }}
                style={{ fontSize: 11, padding: '4px 10px', border: '1px solid var(--border)', borderRadius: 6, background: 'transparent', cursor: 'pointer', color: 'var(--text-secondary)' }}
                title="Log out and refresh session"
              >⏻ Logout</button>
            </div>
          </header>
          <main className={`app-main${isFullWidth ? ' full-width' : ''}`}>
            {activeTab === 'home' && <Home onNavigate={navigateTo} />}
            {activeTab === 'intro' && <Intro />}
            {activeTab === 'services' && <ServiceManager />}
            {activeTab === 'regions' && <RegionBuilder />}
            {activeTab === 'matrix' && <MatrixBuilder />}
            {activeTab === 'viewer' && <MatrixViewer />}
            {activeTab === 'functions' && <FunctionTester />}
            {activeCategory === 'dwell' && <DwellAnalysis subTab={activeSubTab} />}
            {activeCategory === 'fleet-delivery' && <FleetDelivery subTab={activeSubTab} />}
            {activeCategory === 'fleet-taxis' && <FleetTaxis subTab={activeSubTab} />}
            {activeCategory === 'route-deviation' && <RouteDeviation subTab={activeSubTab} />}
            {activeTab === 'route-opt' && <RouteOptimization />}
            {activeTab === 'retail' && <RetailCatchment />}
            {activeTab === 'agent' && <AgentPlayground />}
            {activeTab === 'studio' && <FleetDataStudio />}
            {activeTab === 'diagnostics' && <Diagnostics />}
          </main>
        </div>
      </div>
      </VehicleTypeContext.Provider>
    </RegionContext.Provider>
  );
}

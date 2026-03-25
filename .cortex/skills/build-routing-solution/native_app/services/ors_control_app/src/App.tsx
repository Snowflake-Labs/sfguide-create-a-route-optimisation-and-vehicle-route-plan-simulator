import { useState } from 'react';
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

type CoreTab = 'services' | 'cities' | 'matrix' | 'viewer' | 'functions' | 'travel-time' | 'dwell' | 'fleet-delivery' | 'fleet-taxis' | 'route-deviation' | 'route-opt' | 'retail' | 'agent' | 'studio';

const PRIMARY_TABS: { key: CoreTab; label: string }[] = [
  { key: 'services', label: 'Services' },
  { key: 'cities', label: 'Cities' },
  { key: 'matrix', label: 'Matrix Builder' },
  { key: 'viewer', label: 'Matrix Viewer' },
  { key: 'functions', label: 'Functions' },
  { key: 'travel-time', label: 'Travel Time' },
  { key: 'dwell', label: 'Dwell Analysis' },
];

const MORE_TABS: { key: CoreTab; label: string }[] = [
  { key: 'fleet-delivery', label: 'Fleet Delivery' },
  { key: 'fleet-taxis', label: 'Fleet Taxis' },
  { key: 'route-deviation', label: 'Route Deviation' },
  { key: 'route-opt', label: 'Route Optimization' },
  { key: 'retail', label: 'Retail Catchment' },
  { key: 'agent', label: 'Agent Playground' },
  { key: 'studio', label: 'Data Studio' },
];

export default function App() {
  const [activeTab, setActiveTab] = useState<CoreTab>('services');
  const [moreOpen, setMoreOpen] = useState(false);

  const region = useRegionProvider();

  const isMoreTab = MORE_TABS.some(t => t.key === activeTab);

  return (
    <RegionContext.Provider value={region.value}>
      <div className="app">
        <header className="app-header">
          <div className="app-logo">
            <img src="/snowflake_h3.png" style={{ height: 36, objectFit: 'contain' }} alt="Snowflake" />
            <span>Routing Service</span>
          </div>
          <nav className="app-tabs">
            {PRIMARY_TABS.map(t => (
              <button key={t.key} className={`tab ${activeTab === t.key ? 'active' : ''}`} onClick={() => { setActiveTab(t.key); setMoreOpen(false); }}>{t.label}</button>
            ))}
            <div className="demo-dropdown" style={{ position: 'relative' }}>
              <button className={`tab ${isMoreTab ? 'active' : ''}`} onClick={() => setMoreOpen(!moreOpen)}>
                More ▾
              </button>
              {moreOpen && (
                <div className="demo-menu">
                  {MORE_TABS.map(t => (
                    <button
                      key={t.key}
                      className={`demo-menu-item ${activeTab === t.key ? 'active' : ''}`}
                      onClick={() => { setActiveTab(t.key); setMoreOpen(false); }}
                    >
                      {t.label}
                    </button>
                  ))}
                </div>
              )}
            </div>
          </nav>
        </header>

        <main className="app-main">
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
    </RegionContext.Provider>
  );
}

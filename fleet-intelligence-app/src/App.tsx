import React, { useState, useCallback } from 'react';
import Header from './components/Header';
import FleetMap from './components/FleetMap';
import ChatPanel from './components/ChatPanel';
import { useFleetStats, useActiveStats, useAgent } from './hooks/useData';
import { CITIES, CALIFORNIA_CENTER, CITY_NAMES } from './types';
import type { CityConfig, MapMode, StatusFilter } from './types';

export default function App() {
  const [selectedCity, setSelectedCity] = useState('Los Angeles');
  const [mapMode, setMapMode] = useState<MapMode>('routes');
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all');
  const { stats, loading: statsLoading } = useFleetStats();
  const { activeStats } = useActiveStats();
  const agent = useAgent();

  const cityConfig: CityConfig = selectedCity === 'All Cities'
    ? CALIFORNIA_CENTER
    : CITIES[selectedCity] || CITIES['Los Angeles'];

  const onCityChange = useCallback((city: string) => {
    setSelectedCity(city);
  }, []);

  const handleStatusFilter = useCallback((filter: StatusFilter) => {
    setStatusFilter(filter);
    if (filter !== 'all') setMapMode('routes');
  }, []);

  return (
    <div className="app-layout">
      <Header />
      <div className="main-content">
        <div className="sidebar">
          <div className="sidebar-city-selector">
            <select
              className="city-select"
              value={selectedCity}
              onChange={(e) => onCityChange(e.target.value)}
            >
              <option value="All Cities">All Cities</option>
              {CITY_NAMES.map((c) => (
                <option key={c} value={c}>{c}</option>
              ))}
            </select>
          </div>
          <div className="sidebar-content">
            <ChatPanel
              agent={agent}
              stats={stats}
              activeStats={activeStats}
              statsLoading={statsLoading}
              selectedCity={selectedCity}
              statusFilter={statusFilter}
              onStatusFilter={handleStatusFilter}
            />
          </div>
        </div>
        <FleetMap
          city={selectedCity}
          cityConfig={cityConfig}
          mapMode={mapMode}
          onMapModeChange={setMapMode}
          statusFilter={statusFilter}
          mapZoomTarget={agent.mapZoomTarget}
          onMapZoomComplete={agent.clearMapZoom}
        />
      </div>
    </div>
  );
}

import React, { useState, useCallback, useEffect } from 'react';
import Header from './components/Header';
import FleetMap from './components/FleetMap';
import ChatPanel from './components/ChatPanel';
import CatchmentPanel from './components/CatchmentPanel';
import MatrixBuilder from './components/MatrixBuilder';
import DataBuilder from './components/DataBuilder';
import { useFleetStats, useActiveStats, useAgent } from './hooks/useData';
import { CITIES, US_CENTER, CITY_NAMES } from './types';
import type { CityConfig, MapMode, StatusFilter, MatrixSelection, CatchmentData, CatchmentRestaurant } from './types';

export default function App() {
  const [selectedCity, setSelectedCity] = useState('San Francisco');
  const [mapMode, setMapMode] = useState<MapMode>('routes');
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all');
  const [matrixBuilderOpen, setMatrixBuilderOpen] = useState(false);
  const [dataBuilderOpen, setDataBuilderOpen] = useState(false);
  const [matrixSelection, setMatrixSelection] = useState<MatrixSelection | null>(null);
  const [driveTimeLimit, setDriveTimeLimit] = useState(60);
  const [catchment, setCatchment] = useState<CatchmentData | null>(null);
  const [catchmentLoading, setCatchmentLoading] = useState(false);
  const [hoveredRestaurant, setHoveredRestaurant] = useState<CatchmentRestaurant | null>(null);
  const { stats, loading: statsLoading } = useFleetStats();
  const { activeStats } = useActiveStats();
  const agent = useAgent();

  const cityConfig: CityConfig = selectedCity === 'All Cities'
    ? US_CENTER
    : CITIES[selectedCity] || CITIES['San Francisco'];

  const onCityChange = useCallback((city: string) => {
    setSelectedCity(city);
  }, []);

  const handleStatusFilter = useCallback((filter: StatusFilter) => {
    setStatusFilter(filter);
    if (filter !== 'all') setMapMode('routes');
  }, []);

  const handleMatrixSelection = useCallback((sel: MatrixSelection | null) => {
    setMatrixSelection(sel);
    if (sel) {
      setDriveTimeLimit(Math.ceil(sel.max_travel_time_secs / 60));
    }
  }, []);

  useEffect(() => {
    if (!matrixSelection) {
      setCatchment(null);
      return;
    }
    const limit = Math.ceil(matrixSelection.max_travel_time_secs / 60);
    setCatchmentLoading(true);
    fetch(`/api/matrix/catchment?origin=${encodeURIComponent(matrixSelection.origin_hex)}&resolution=${matrixSelection.resolution}&max_minutes=${limit}`)
      .then((r) => r.json())
      .then((data) => { setCatchment(data); setCatchmentLoading(false); })
      .catch(() => { setCatchment(null); setCatchmentLoading(false); });
  }, [matrixSelection?.origin_hex, matrixSelection?.resolution, matrixSelection?.max_travel_time_secs]);

  return (
    <div className="app-layout">
      <Header onMatrixBuilder={() => setMatrixBuilderOpen(true)} onDataBuilder={() => setDataBuilderOpen(true)} />
      <div className="main-content">
        <div className="sidebar">
          <div className="sidebar-city-selector">
            <select
              className="city-select"
              value={selectedCity}
              onChange={(e) => onCityChange(e.target.value)}
            >
              <option value="All Cities" disabled style={{ color: '#666' }}>All Cities (disabled)</option>
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
              matrixSelection={matrixSelection}
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
          onMatrixSelection={handleMatrixSelection}
          catchmentRestaurants={catchment?.restaurants}
          catchmentCustomers={catchment?.customers}
          hoveredRestaurant={hoveredRestaurant}
        />
        {matrixSelection && mapMode === 'matrix' && (
          <CatchmentPanel
            catchment={catchment}
            loading={catchmentLoading}
            onRestaurantHover={setHoveredRestaurant}
          />
        )}
      </div>
      <MatrixBuilder
        open={matrixBuilderOpen}
        onClose={() => setMatrixBuilderOpen(false)}
      />
      <DataBuilder
        open={dataBuilderOpen}
        onClose={() => setDataBuilderOpen(false)}
        initialCity={selectedCity}
      />
    </div>
  );
}

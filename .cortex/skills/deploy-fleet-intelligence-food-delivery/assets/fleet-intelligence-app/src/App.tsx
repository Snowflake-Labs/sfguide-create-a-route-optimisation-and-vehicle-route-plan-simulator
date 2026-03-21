import React, { useState, useCallback, useEffect } from 'react';
import Header from './components/Header';
import FleetMap from './components/FleetMap';
import ChatPanel from './components/ChatPanel';
import CatchmentPanel from './components/CatchmentPanel';
import MatrixBuilder from './components/MatrixBuilder';
import DataBuilder from './components/DataBuilder';
import { useFleetStats, useActiveStats, useAgent, useAlerts } from './hooks/useData';
import { CITIES, US_CENTER, CITY_NAMES } from './types';
import type { CityConfig, MapMode, StatusFilter, MapFilter, MatrixSelection, CatchmentData, CatchmentRestaurant } from './types';
import { DEFAULT_MAP_FILTER } from './types';

export default function App() {
  const [selectedCity, setSelectedCity] = useState('San Francisco');
  const [mapMode, setMapMode] = useState<MapMode>('routes');
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all');
  const [mapFilter, setMapFilter] = useState<MapFilter>(DEFAULT_MAP_FILTER);
  const [matrixBuilderOpen, setMatrixBuilderOpen] = useState(false);
  const [dataBuilderOpen, setDataBuilderOpen] = useState(false);
  const [matrixSelection, setMatrixSelection] = useState<MatrixSelection | null>(null);
  const [driveTimeLimit, setDriveTimeLimit] = useState(60);
  const [catchment, setCatchment] = useState<CatchmentData | null>(null);
  const [catchmentLoading, setCatchmentLoading] = useState(false);
  const [hoveredRestaurant, setHoveredRestaurant] = useState<CatchmentRestaurant | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);
  const { stats, loading: statsLoading } = useFleetStats(refreshKey);
  const { activeStats } = useActiveStats(refreshKey);
  const agent = useAgent();
  const alerts = useAlerts(selectedCity, refreshKey);
  const [alertDismissed, setAlertDismissed] = useState(false);

  const cityConfig: CityConfig = selectedCity === 'All Cities'
    ? US_CENTER
    : CITIES[selectedCity] || CITIES['San Francisco'];

  const onCityChange = useCallback((city: string) => {
    setSelectedCity(city);
  }, []);

  const handleStatusFilter = useCallback((filter: StatusFilter) => {
    setStatusFilter(filter);
    setMapFilter(filter === 'all' ? DEFAULT_MAP_FILTER : { type: 'status', value: filter, label: filter === 'active' ? 'Active Only' : filter.replace(/_/g, ' ') });
    if (filter !== 'all') setMapMode('routes');
  }, []);

  const handleMapFilter = useCallback((filter: MapFilter) => {
    setMapFilter(filter);
    setStatusFilter('all');
    if (filter.type !== 'all') setMapMode('routes');
  }, []);

  const handleClearMapFilter = useCallback(() => {
    setMapFilter(DEFAULT_MAP_FILTER);
    setStatusFilter('all');
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
    fetch(`/api/matrix/catchment?origin=${encodeURIComponent(matrixSelection.origin_hex)}&resolution=${matrixSelection.resolution}&max_minutes=${limit}&city=${encodeURIComponent(selectedCity)}`)
      .then((r) => r.json())
      .then((data) => { setCatchment(data); setCatchmentLoading(false); })
      .catch(() => { setCatchment(null); setCatchmentLoading(false); });
  }, [matrixSelection?.origin_hex, matrixSelection?.resolution, matrixSelection?.max_travel_time_secs]);

  return (
    <div className="app-layout">
      <Header onMatrixBuilder={() => setMatrixBuilderOpen(true)} onDataBuilder={() => setDataBuilderOpen(true)} />
      {alertDismissed && alerts.length > 0 && (
        <button className="alert-reopen" onClick={() => setAlertDismissed(false)}>&#9888; Show Alerts ({alerts.filter(a => a.type === 'flood' || a.type === 'incident_summary').length})</button>
      )}
      {!alertDismissed && alerts.filter(a => a.type === 'flood').map((flood) => (
        <div key={flood.id} className="alert-banner alert-flood">
          <div className="alert-icon">&#9888;</div>
          <div className="alert-content">
            <strong>{flood.title}</strong>
            <span className={`alert-severity alert-severity-${flood.severity}`}>{flood.severity?.toUpperCase()}</span>
            <span className="alert-description">{flood.description?.slice(0, 150)}{(flood.description?.length || 0) > 150 ? '...' : ''}</span>
            {flood.affected_roads ? <span className="alert-meta">~{flood.affected_roads} roads affected | Water level: {flood.water_level_m}m</span> : null}
          </div>
          <button className="alert-dismiss" onClick={() => setAlertDismissed(true)}>&#10005;</button>
        </div>
      ))}
      {!alertDismissed && alerts.filter(a => a.type === 'incident_summary').map((inc, i) => {
        const flooding = inc.incidents?.flooding;
        const weather = inc.incidents?.weather;
        const traffic = inc.incidents?.traffic;
        const total = (flooding?.count || 0) + (weather?.count || 0) + (traffic?.count || 0);
        if (total === 0) return null;
        return (
          <div key={`inc-${i}`} className="alert-banner alert-incidents">
            <div className="alert-icon">&#128666;</div>
            <div className="alert-content">
              <strong>{total} delivery incidents active</strong>
              {flooding && <span className="alert-meta">{flooding.count} flood-related (avg {flooding.avg_delay} min delay)</span>}
              {weather && <span className="alert-meta">{weather.count} weather-related (avg {weather.avg_delay} min delay)</span>}
              {traffic && <span className="alert-meta">{traffic.count} traffic-related (avg {traffic.avg_delay} min delay)</span>}
            </div>
          </div>
        );
      })}
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
              onMapFilter={handleMapFilter}
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
          mapFilter={mapFilter}
          onClearMapFilter={handleClearMapFilter}
          mapZoomTarget={agent.mapZoomTarget}
          onMapZoomComplete={agent.clearMapZoom}
          onMatrixSelection={handleMatrixSelection}
          catchmentRestaurants={catchment?.restaurants}
          catchmentCustomers={catchment?.customers}
          hoveredRestaurant={hoveredRestaurant}
          refreshKey={refreshKey}
          floodAlerts={alerts}
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
        onDataBuilt={() => setRefreshKey((k) => k + 1)}
      />
    </div>
  );
}

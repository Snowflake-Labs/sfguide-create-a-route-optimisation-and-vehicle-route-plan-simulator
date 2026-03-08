import React from 'react';
import type { FleetStats } from '../types';

function fmt(n: number | undefined | null): string {
  if (!n) return '0';
  return n.toLocaleString('en-US');
}

interface Props {
  stats: FleetStats | null;
  loading: boolean;
  selectedCity: string;
}

export default function StatsPanel({ stats, loading, selectedCity }: Props) {
  if (loading || !stats) {
    return <div className="loading-spinner">Loading fleet statistics...</div>;
  }

  const cityStats = selectedCity === 'All Cities'
    ? null
    : stats.cities.find((c) => c.city === selectedCity);

  return (
    <div>
      <div className="stat-card highlight-orange">
        <div className="stat-card-header">Total Deliveries</div>
        <div className="stat-card-value">{fmt(stats.total_orders)}</div>
        <div className="stat-card-detail">across {stats.cities.length} California cities</div>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '10px' }}>
        <div className="stat-card">
          <div className="stat-card-header">Active Couriers</div>
          <div className="stat-card-value" style={{ fontSize: 22 }}>{fmt(stats.total_couriers)}</div>
        </div>
        <div className="stat-card">
          <div className="stat-card-header">Restaurants</div>
          <div className="stat-card-value" style={{ fontSize: 22 }}>{fmt(stats.total_restaurants)}</div>
        </div>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '10px' }}>
        <div className="stat-card">
          <div className="stat-card-header">Total Distance</div>
          <div className="stat-card-value" style={{ fontSize: 22 }}>{fmt(Math.round(stats.total_km))} km</div>
        </div>
        <div className="stat-card">
          <div className="stat-card-header">Avg Delivery Time</div>
          <div className="stat-card-value" style={{ fontSize: 22 }}>{stats.avg_delivery_mins.toFixed(1)} min</div>
        </div>
      </div>

      {cityStats && (
        <>
          <div className="section-title">{selectedCity}</div>
          <div className="stat-card">
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '8px' }}>
              <div>
                <div className="stat-card-header">Orders</div>
                <div style={{ fontSize: 18, fontWeight: 700 }}>{fmt(cityStats.orders)}</div>
              </div>
              <div>
                <div className="stat-card-header">Couriers</div>
                <div style={{ fontSize: 18, fontWeight: 700 }}>{fmt(cityStats.couriers)}</div>
              </div>
              <div>
                <div className="stat-card-header">Distance</div>
                <div style={{ fontSize: 18, fontWeight: 700 }}>{fmt(Math.round(cityStats.total_km))} km</div>
              </div>
              <div>
                <div className="stat-card-header">Avg Time</div>
                <div style={{ fontSize: 18, fontWeight: 700 }}>{cityStats.avg_mins.toFixed(1)} min</div>
              </div>
            </div>
          </div>
        </>
      )}

      <div className="section-title">All Cities</div>
      <div className="city-table-wrapper">
        <table className="city-table">
          <thead>
            <tr>
              <th>City</th>
              <th>Orders</th>
              <th>Couriers</th>
              <th>Avg (min)</th>
            </tr>
          </thead>
          <tbody>
            {stats.cities.map((c) => (
              <tr key={c.city} className={c.city === selectedCity ? 'selected' : ''}>
                <td>{c.city}</td>
                <td>{fmt(c.orders)}</td>
                <td>{c.couriers}</td>
                <td>{c.avg_mins.toFixed(1)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

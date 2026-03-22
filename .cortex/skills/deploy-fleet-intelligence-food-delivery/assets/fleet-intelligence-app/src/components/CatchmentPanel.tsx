import React, { useState, useMemo } from 'react';
import type { CatchmentData, CatchmentRestaurant } from '../types';

interface Props {
  catchment: CatchmentData | null;
  loading: boolean;
  onRestaurantHover?: (restaurant: CatchmentRestaurant | null) => void;
}

export default function CatchmentPanel({ catchment, loading, onRestaurantHover }: Props) {
  const [sortBy, setSortBy] = useState<'orders' | 'drive_mins' | 'active'>('orders');

  const sortedRestaurants = useMemo(() => {
    if (!catchment) return [];
    return [...catchment.restaurants].sort((a, b) => {
      if (sortBy === 'orders') return b.orders - a.orders;
      if (sortBy === 'active') return b.active - a.active;
      return a.drive_mins - b.drive_mins;
    });
  }, [catchment, sortBy]);

  const stats = useMemo(() => {
    if (!catchment) return { restaurants: 0, customers: 0, active: 0, cuisines: 0 };
    const cuisines = new Set(catchment.restaurants.map((r) => r.cuisine));
    const active = catchment.restaurants.reduce((s, r) => s + r.active, 0);
    return {
      restaurants: catchment.restaurants.length,
      customers: catchment.customers.length,
      active,
      cuisines: cuisines.size,
    };
  }, [catchment]);

  return (
    <div className="catchment-panel">
      <div className="catchment-header">
        <span className="catchment-title">Catchment Area</span>
        {catchment && <span className="catchment-subtitle">{catchment.max_minutes} min drive</span>}
      </div>

      {loading ? (
        <div className="catchment-loading">
          <div className="catchment-loading-spinner" />
          Querying deliveries...
        </div>
      ) : catchment && catchment.restaurants.length > 0 ? (
        <>
          <div className="catchment-stats">
            <div className="catchment-stat">
              <span className="catchment-stat-value">{stats.restaurants}</span>
              <span className="catchment-stat-label">Restaurants</span>
            </div>
            <div className="catchment-stat">
              <span className="catchment-stat-value">{stats.customers}</span>
              <span className="catchment-stat-label">Deliveries</span>
            </div>
            <div className="catchment-stat">
              <span className="catchment-stat-value">{stats.active}</span>
              <span className="catchment-stat-label">Active</span>
            </div>
            <div className="catchment-stat">
              <span className="catchment-stat-value">{stats.cuisines}</span>
              <span className="catchment-stat-label">Cuisines</span>
            </div>
          </div>

          <div className="catchment-sort">
            <span className="catchment-sort-label">Sort</span>
            <button className={`catchment-sort-btn ${sortBy === 'orders' ? 'active' : ''}`} onClick={() => setSortBy('orders')}>Orders</button>
            <button className={`catchment-sort-btn ${sortBy === 'drive_mins' ? 'active' : ''}`} onClick={() => setSortBy('drive_mins')}>Distance</button>
            <button className={`catchment-sort-btn ${sortBy === 'active' ? 'active' : ''}`} onClick={() => setSortBy('active')}>Active</button>
          </div>

          <div className="catchment-list">
            {sortedRestaurants.map((r, i) => (
              <div
                key={r.name + i}
                className="catchment-restaurant"
                onMouseEnter={() => onRestaurantHover?.(r)}
                onMouseLeave={() => onRestaurantHover?.(null)}
              >
                <div className="catchment-restaurant-header">
                  <span className="catchment-restaurant-name">{r.name}</span>
                  <span className="catchment-restaurant-time">{r.drive_mins} min</span>
                </div>
                <div className="catchment-restaurant-meta">
                  <span className="catchment-restaurant-cuisine">{r.cuisine?.replace(/_/g, ' ')}</span>
                  <span className="catchment-restaurant-city">{r.city}</span>
                </div>
                <div className="catchment-restaurant-stats">
                  <span className="catchment-restaurant-orders">{r.orders} orders</span>
                  {r.active > 0 && <span className="catchment-restaurant-active">{r.active} active</span>}
                </div>
              </div>
            ))}
          </div>
        </>
      ) : catchment ? (
        <div className="catchment-empty">No deliveries found in this catchment area</div>
      ) : null}
    </div>
  );
}

// Snowflake-via-sfQuery hooks for the Freight Exchange page. Each hook owns
// one read and exposes { rows, loading, refetch }. Adding a new SQL surface
// (e.g. useDeadhead, useTrailers) is a single new function here - UI files
// import the hook and never touch the query string.

import { useEffect, useRef, useState, useCallback } from 'react';
import { sfQuery } from '../../lib/sfQuery';
import { FX_DB, FX_SCHEMA } from './constants';
import { postOfferRoute } from './api';
import { parseRouteGeometry } from './helpers';
import type { Offer, LaneRow, Trailer } from './types';

/** Loads VW_OFFER_ENRICHED. Includes ROAD_KM/ROAD_MIN/ROUTE_GEOMETRY/
 *  ROUTE_DETOUR_BADGE for offers batch-routed via POST /api/fx/refresh-routes;
 *  those columns stay null for offers that haven't been routed yet. */
export function useOffers() {
  const [rows, setRows] = useState<Offer[]>([]);
  const [loading, setLoading] = useState(true);
  const [version, setVersion] = useState(0);

  const refetch = useCallback(() => setVersion(v => v + 1), []);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    sfQuery(
      `SELECT * FROM ${FX_DB}.${FX_SCHEMA}.VW_OFFER_ENRICHED ORDER BY POSTED_AT DESC LIMIT 500`,
      FX_DB, FX_SCHEMA,
    ).then(r => {
      if (cancelled) return;
      setRows(r as Offer[]);
      setLoading(false);
    }).catch(() => {
      if (!cancelled) setLoading(false);
    });
    return () => { cancelled = true; };
  }, [version]);

  return { rows, loading, refetch };
}

/** Loads VW_LANE_HISTORY for one (partner, equipment) pair. Returns the
 *  first row or null. */
export function useLaneHistory(partnerId: string | null | undefined, equipment: string | null | undefined) {
  const [row, setRow] = useState<LaneRow | null>(null);

  useEffect(() => {
    if (!partnerId || !equipment) { setRow(null); return; }
    let cancelled = false;
    sfQuery(
      `SELECT * FROM ${FX_DB}.${FX_SCHEMA}.VW_LANE_HISTORY
       WHERE PARTNER_ID = '${partnerId.replace(/'/g, "''")}'
         AND EQUIPMENT  = '${equipment.replace(/'/g, "''")}'
       LIMIT 1`,
      FX_DB, FX_SCHEMA,
    ).then(r => {
      if (cancelled) return;
      setRow(((r as LaneRow[])[0]) || null);
    });
    return () => { cancelled = true; };
  }, [partnerId, equipment]);

  return row;
}

/** Loads VW_TRAILERS for the active region. Used by the trailer-picker
 *  dropdown in a future enrichment turn (E2/E3/E4). */
export function useTrailers() {
  const [rows, setRows] = useState<Trailer[]>([]);
  useEffect(() => {
    let cancelled = false;
    sfQuery(
      `SELECT TRAILER_ID, DROPOFF_CITY, DROPOFF_LON, DROPOFF_LAT, HOME_LON, HOME_LAT, ETA_MIN
       FROM FLEET_INTELLIGENCE.BACKLOAD_MATCHING.VW_TRAILERS
       WHERE DROPOFF_LON IS NOT NULL
       LIMIT 200`,
      FX_DB, FX_SCHEMA,
    ).then(r => { if (!cancelled) setRows(r as Trailer[]); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, []);
  return rows;
}

export interface SelectedOfferRoute {
  coords: [number, number][] | null;
  roadKm: number | null;
  roadMin: number | null;
  loading: boolean;
  source: 'cache' | 'live' | 'none';
}

/** Resolves the pickup -> dropoff travel path + road km/min for the selected
 *  offer. Prefers the V2 cache (selected.ROUTE_GEOMETRY) when present, falls
 *  back to a live POST /api/fx/offer-route call. Component-level Map keyed by
 *  OFFER_ID caches live responses so reselecting an offer is free. On ORS
 *  failure returns null coords/roadKm/roadMin with source='live' so the map
 *  keeps the markers but drops the path. */
export function useSelectedOfferRoute(
  selected: Offer | null,
): SelectedOfferRoute {
  const liveCacheRef = useRef<Map<string, { coords: [number, number][] | null; roadKm: number | null; roadMin: number | null }>>(new Map());
  const [, forceRender] = useState(0);
  const [loading, setLoading] = useState(false);

  const offerId = selected?.OFFER_ID ?? null;

  useEffect(() => {
    if (!selected || !offerId) { setLoading(false); return; }
    if (parseRouteGeometry(selected.ROUTE_GEOMETRY) !== null) { setLoading(false); return; }
    if (liveCacheRef.current.has(offerId)) { setLoading(false); return; }

    let cancelled = false;
    setLoading(true);
    postOfferRoute({ offerId })
      .then(res => {
        if (cancelled) return;
        const coords = parseRouteGeometry(res?.geometry ?? null);
        liveCacheRef.current.set(offerId, {
          coords,
          roadKm: res?.roadKm ?? null,
          roadMin: res?.roadMin ?? null,
        });
        setLoading(false);
        forceRender(v => v + 1);
      })
      .catch(() => {
        if (cancelled) return;
        liveCacheRef.current.set(offerId, { coords: null, roadKm: null, roadMin: null });
        setLoading(false);
        forceRender(v => v + 1);
      });
    return () => { cancelled = true; };
  }, [offerId, selected?.ROUTE_GEOMETRY]);

  if (!selected || !offerId) {
    return { coords: null, roadKm: null, roadMin: null, loading: false, source: 'none' };
  }

  const cachedCoords = parseRouteGeometry(selected.ROUTE_GEOMETRY);
  if (cachedCoords) {
    return {
      coords: cachedCoords,
      roadKm: selected.ROAD_KM ?? null,
      roadMin: selected.ROAD_MIN ?? null,
      loading: false,
      source: 'cache',
    };
  }

  const live = liveCacheRef.current.get(offerId);
  if (live) {
    return {
      coords: live.coords,
      roadKm: live.roadKm,
      roadMin: live.roadMin,
      loading: false,
      source: 'live',
    };
  }

  return { coords: null, roadKm: null, roadMin: null, loading, source: 'live' };
}

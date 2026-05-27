// Snowflake-via-sfQuery hooks for the Freight Exchange page. Each hook owns
// one read and exposes { rows, loading, refetch }. Adding a new SQL surface
// (e.g. useDeadhead, useTrailers) is a single new function here — UI files
// import the hook and never touch the query string.

import { useEffect, useState, useCallback } from 'react';
import { sfQuery } from '../../lib/sfQuery';
import { FX_DB, FX_SCHEMA } from './constants';
import type { Offer, LaneRow, Trailer } from './types';

/** Loads VW_OFFER_ENRICHED. Switch to VW_OFFER_ENRICHED_V2 in a follow-up
 *  enrichment turn — single-line change here, no other file touched. */
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

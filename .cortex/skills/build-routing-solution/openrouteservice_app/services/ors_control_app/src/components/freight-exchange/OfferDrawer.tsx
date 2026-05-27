// Right-rail detail drawer for the selected offer. Composes Phase B panels;
// future enrichment turns add Route/Deadhead/Actions/RoundTripResult/etc.
// panels by importing them and dropping them next to the existing ones.

import type { Offer, LaneRow } from './types';
import type { SelectedOfferRoute } from './sql';
import { renderTrust, renderMarket, formatDuration } from './helpers';
import PartnerPanel from './panels/PartnerPanel';
import MarketPanel from './panels/MarketPanel';
import LaneHistoryPanel from './panels/LaneHistoryPanel';

interface Props {
  selected: Offer | null;
  laneHistory: LaneRow | null;
  route: SelectedOfferRoute;
}

const HR = <hr style={{ margin: '8px 0', border: 'none', borderTop: '1px solid #e5e7eb' }} />;

export default function OfferDrawer({ selected, laneHistory, route }: Props) {
  // Live > V2 cache > '—'. Live (from /api/fx/offer-route) and V2 cache
  // (selected.ROAD_KM / ROAD_MIN) both come from the same FACT_OFFER_ROUTES
  // contract, so the precedence is purely about freshness.
  const roadKm = route.roadKm ?? selected?.ROAD_KM ?? null;
  const roadMin = route.roadMin ?? selected?.ROAD_MIN ?? null;
  const roadKmLabel = roadKm != null && Number.isFinite(roadKm)
    ? `${roadKm.toFixed(0)} km`
    : route.loading ? '…' : '—';
  const roadMinLabel = roadMin != null && Number.isFinite(roadMin)
    ? formatDuration(roadMin)
    : route.loading ? '…' : '—';
  return (
    <div style={{ overflow: 'auto', border: '1px solid #e5e7eb', borderRadius: 6, background: '#fff', padding: 12 }}>
      {!selected ? (
        <div style={{ color: '#6b7280', fontSize: 12 }}>
          Click an offer in the grid or on the map to see details, partner trust, and lane history.
        </div>
      ) : (
        <div style={{ fontSize: 12, lineHeight: 1.5 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 8 }}>
            <div>
              <div style={{ fontSize: 13, fontWeight: 700 }}>{selected.OFFER_ID}</div>
              <div style={{ color: '#6b7280', fontSize: 11 }}>{selected.SOURCE}</div>
            </div>
            <div style={{ textAlign: 'right' }}>
              <div>{renderTrust(selected.TRUST_BADGE)}</div>
              <div>{renderMarket(selected)}</div>
            </div>
          </div>
          {HR}
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 6 }}>
            <div><b>Pickup:</b> {selected.PICKUP_CITY}</div>
            <div><b>Drop:</b> {selected.DROPOFF_CITY}</div>
            <div><b>Distance:</b> {selected.DISTANCE_KM != null ? `${selected.DISTANCE_KM.toFixed(0)} km` : '—'}</div>
            <div><b>Equipment:</b> {selected.EQUIPMENT || '—'}</div>
            <div><b>Road km:</b> {roadKmLabel}</div>
            <div><b>Road time:</b> {roadMinLabel}</div>
            <div><b>Weight:</b> {selected.WEIGHT_KG.toLocaleString()} kg</div>
            <div><b>LDM:</b> {selected.LDM != null ? selected.LDM.toFixed(1) : '—'}</div>
            <div><b>Price:</b> ${selected.PRICE_USD.toLocaleString()}</div>
            <div><b>USD/km:</b> {selected.PRICE_PER_KM_USD != null ? `$${selected.PRICE_PER_KM_USD.toFixed(2)}` : '—'}</div>
            <div><b>ADR:</b> {selected.HAZMAT ? `class ${selected.ADR_CLASS}` : 'no'}</div>
            <div><b>Status:</b> {selected.STATUS}</div>
          </div>
          {HR}
          <PartnerPanel offer={selected} />
          {HR}
          <MarketPanel offer={selected} />
          {HR}
          <LaneHistoryPanel row={laneHistory} />
        </div>
      )}
    </div>
  );
}

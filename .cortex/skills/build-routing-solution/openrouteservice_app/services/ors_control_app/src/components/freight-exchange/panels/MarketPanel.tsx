// Market benchmark p25/p50/p75 USD/km block (Phase B).

import type { Offer } from '../types';

export default function MarketPanel({ offer }: { offer: Offer }) {
  return (
    <div>
      <div style={{ fontWeight: 600, marginBottom: 4, fontSize: 12 }}>
        Market benchmark (this equipment, this week)
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 4 }}>
        <div><b>p25:</b> {offer.MARKET_P25 != null ? `$${offer.MARKET_P25.toFixed(2)}` : '-'}</div>
        <div><b>p50:</b> {offer.MARKET_P50 != null ? `$${offer.MARKET_P50.toFixed(2)}` : '-'}</div>
        <div><b>p75:</b> {offer.MARKET_P75 != null ? `$${offer.MARKET_P75.toFixed(2)}` : '-'}</div>
      </div>
    </div>
  );
}

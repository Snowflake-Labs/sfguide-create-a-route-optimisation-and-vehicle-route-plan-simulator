// Sortable offers grid. Pure presentational — orchestrator owns sort state
// and passes it in.

import type { Offer, SortKey, SortDir } from './types';
import { SOURCE_COLOR, thStyle, tdStyle, tdNum } from './constants';
import { renderTrust, renderMarket } from './helpers';

interface Props {
  rows: Offer[];
  loading: boolean;
  totalRows: number;
  selected: Offer | null;
  onSelect: (offer: Offer) => void;
  sortKey: SortKey;
  sortDir: SortDir;
  onSort: (key: SortKey) => void;
}

export default function OffersGrid({ rows, loading, totalRows, selected, onSelect, sortKey, sortDir, onSort }: Props) {
  const sortable = (key: SortKey, label: string) => (
    <th
      style={{ ...thStyle, cursor: 'pointer', userSelect: 'none' }}
      onClick={() => onSort(key)}
    >
      {label}{sortKey === key ? (sortDir === 'asc' ? ' ▲' : ' ▼') : ''}
    </th>
  );

  return (
    <div style={{ overflow: 'auto', border: '1px solid #e5e7eb', borderRadius: 6, background: '#fff' }}>
      {loading ? (
        <div style={{ padding: 24, color: '#6b7280' }}>Loading offers…</div>
      ) : rows.length === 0 ? (
        <div style={{ padding: 24, color: '#6b7280' }}>
          No offers match your filters. {totalRows === 0 && (
            <span> The current preset has no FACT_FREIGHT_OFFERS rows — run a Data Studio job for the active preset.</span>
          )}
        </div>
      ) : (
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
          <thead style={{ position: 'sticky', top: 0, zIndex: 1 }}>
            <tr>
              {sortable('SOURCE', 'Source')}
              {sortable('PICKUP_CITY', 'Pickup')}
              {sortable('DROPOFF_CITY', 'Drop')}
              {sortable('DISTANCE_KM', 'Dist km')}
              {sortable('EQUIPMENT', 'Equip')}
              <th style={thStyle}>ADR</th>
              {sortable('WEIGHT_KG', 'Weight')}
              {sortable('PRICE_USD', 'USD')}
              {sortable('PRICE_PER_KM_USD', 'USD/km')}
              {sortable('POSTED_AGE_MIN', 'Age')}
              {sortable('TRUST_BADGE', 'Trust')}
              {sortable('MARKET_BADGE', 'Mkt')}
              {sortable('STATUS', 'Status')}
            </tr>
          </thead>
          <tbody>
            {rows.map(o => {
              const isSel = o.OFFER_ID === selected?.OFFER_ID;
              const sourceColor = SOURCE_COLOR[o.SOURCE] || [128, 128, 128];
              return (
                <tr
                  key={o.OFFER_ID}
                  onClick={() => onSelect(o)}
                  style={{ cursor: 'pointer', background: isSel ? '#dbeafe' : undefined, borderBottom: '1px solid #f3f4f6' }}
                >
                  <td style={tdStyle}>
                    <span style={{ display: 'inline-block', width: 8, height: 8, borderRadius: 4, background: `rgb(${sourceColor.join(',')})`, marginRight: 5 }} />
                    {o.SOURCE}
                  </td>
                  <td style={tdStyle}>{o.PICKUP_CITY}</td>
                  <td style={tdStyle}>{o.DROPOFF_CITY}</td>
                  <td style={tdNum}>{o.DISTANCE_KM != null ? o.DISTANCE_KM.toFixed(0) : '—'}</td>
                  <td style={tdStyle}>{o.EQUIPMENT || '—'}</td>
                  <td style={tdStyle}>{o.HAZMAT ? `ADR ${o.ADR_CLASS || ''}` : '—'}</td>
                  <td style={tdNum}>{o.WEIGHT_KG.toLocaleString()}</td>
                  <td style={tdNum}>{'$' + o.PRICE_USD.toLocaleString()}</td>
                  <td style={tdNum}>{o.PRICE_PER_KM_USD != null ? `$${o.PRICE_PER_KM_USD.toFixed(2)}` : '—'}</td>
                  <td style={tdNum}>{o.POSTED_AGE_MIN < 60 ? `${o.POSTED_AGE_MIN}m` : `${Math.round(o.POSTED_AGE_MIN / 60)}h`}</td>
                  <td style={tdStyle}>{renderTrust(o.TRUST_BADGE)}</td>
                  <td style={tdStyle}>{renderMarket(o)}</td>
                  <td style={tdStyle}>
                    <span style={{
                      fontSize: 10, padding: '1px 6px', borderRadius: 3, fontWeight: 600,
                      color: o.STATUS === 'OPEN' ? '#15803d' : o.STATUS === 'TAKEN' ? '#6b7280' : '#dc2626',
                      background: o.STATUS === 'OPEN' ? '#dcfce7' : o.STATUS === 'TAKEN' ? '#f3f4f6' : '#fee2e2',
                    }}>{o.STATUS}</span>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </div>
  );
}

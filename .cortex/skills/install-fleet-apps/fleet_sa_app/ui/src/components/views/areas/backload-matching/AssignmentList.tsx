'use client';

import type { CSSProperties } from 'react';
import { Assignment, ROUTE_COLORS } from './helpers';

interface Props {
  assignments: Assignment[];
  unassigned: { id: number; reason?: string }[];
  selectedAssignment: string | null;
  onSelect: (id: string) => void;
  rationale: Record<string, string>;
  rationaleLoading: boolean;
  onAskRationale: (a: Assignment) => void;
}

function netBadgeStyle(net: number | undefined): CSSProperties {
  if (net === undefined) return { display: 'none' };
  const positive = net >= 0;
  return {
    fontSize: 11, padding: '1px 6px', borderRadius: 4, fontWeight: 600,
    background: positive ? 'rgba(22,163,74,0.18)' : 'rgba(239,68,68,0.18)',
    color: positive ? '#065f46' : '#991b1b',
  };
}

export default function AssignmentList({
  assignments, unassigned, selectedAssignment, onSelect, rationale, rationaleLoading, onAskRationale,
}: Props) {
  return (
    <div style={{ height: 560, overflowY: 'auto', border: '1px solid var(--border-default, #e5e7eb)', borderRadius: 8, padding: 8 }}>
      <h3 style={{ fontSize: 13, marginTop: 0 }}>Assignments ({assignments.length})</h3>
      {!assignments.length && (
        <div style={{ fontSize: 12, color: 'var(--text-secondary, #6b7280)' }}>
          Click <b>Solve Backloads</b> to compute the optimal plan.
        </div>
      )}
      {assignments.map((a, i) => {
        const c = ROUTE_COLORS[i % ROUTE_COLORS.length];
        const isSel = selectedAssignment === a.ASSIGNMENT_ID;
        const net = a.NET_BENEFIT_USD;
        return (
          <div key={a.ASSIGNMENT_ID} onClick={() => onSelect(a.ASSIGNMENT_ID)}
               style={{ padding: 8, borderRadius: 6, marginBottom: 6, cursor: 'pointer',
                        border: isSel ? '1px solid #16a34a' : '1px solid var(--border-default, #e5e7eb)',
                        background: isSel ? 'rgba(22,163,74,0.06)' : 'transparent' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
              <span style={{ width: 10, height: 10, borderRadius: 2, background: `rgb(${c.join(',')})`, flexShrink: 0 }} />
              <b style={{ fontSize: 12 }}>{a.TRAILER_ID}</b>
              <span style={{ fontSize: 10, color: 'var(--text-secondary, #6b7280)' }}>&middot; {a.OFFER_ID}</span>
              <span style={{ fontSize: 11, padding: '1px 6px', borderRadius: 4, background: a.SOURCE === 'INTERNAL' ? 'rgba(41,181,232,0.18)' : 'rgba(200,200,200,0.4)' }}>
                {a.SOURCE}
              </span>
              {net !== undefined && (
                <span style={netBadgeStyle(net)}>
                  {net >= 0 ? '+' : ''}${Math.round(net)}
                </span>
              )}
            </div>
            <div style={{ fontSize: 11, color: 'var(--text-secondary, #6b7280)', marginTop: 2 }}>
              {a.PICKUP_CITY} -&gt; {a.PROPOSAL_DROPOFF_CITY}
            </div>
            <div style={{ fontSize: 11, marginTop: 2 }}>
              empty {Math.round(a.EMPTY_KM)} km &middot; loaded {Math.round(a.LOADED_KM)} km &middot; {a.PRODUCT}
            </div>
            {(a.REVENUE_USD !== undefined || a.COST_USD !== undefined) && (
              <div style={{ fontSize: 11, marginTop: 2, color: 'var(--text-secondary, #6b7280)' }}>
                rev ${Math.round(a.REVENUE_USD || 0)} &middot; cost ${Math.round(a.COST_USD || 0)}
                {a.N_DELIVERIES ? ` \u00b7 ${a.N_DELIVERIES} deliv` : ''}
                {a.WAIT_SEC ? ` \u00b7 wait ${Math.round(a.WAIT_SEC / 60)} min` : ''}
              </div>
            )}
            {a.DETOUR_KM !== undefined && (
              <div style={{ fontSize: 11, marginTop: 2, color: 'var(--text-secondary, #6b7280)' }}>
                detour +{Math.round(a.DETOUR_KM)} km vs direct{a.SAVED_KM ? ` \u00b7 empty saved ~${Math.round(a.SAVED_KM)} km` : ''}
              </div>
            )}
            {isSel && (
              <div style={{ marginTop: 6 }}>
                <button onClick={(e) => { e.stopPropagation(); onAskRationale(a); }} disabled={rationaleLoading}
                        style={{ fontSize: 11, padding: '3px 8px', border: '1px solid var(--border-default, #e5e7eb)', borderRadius: 4, background: 'transparent', cursor: 'pointer' }}>
                  {rationaleLoading ? 'Asking Cortex...' : 'Why this assignment?'}
                </button>
                {rationale[a.ASSIGNMENT_ID] && (
                  <div style={{ marginTop: 6, padding: 6, fontSize: 11, background: 'rgba(0,0,0,0.04)', borderRadius: 4 }}>
                    {rationale[a.ASSIGNMENT_ID]}
                  </div>
                )}
              </div>
            )}
          </div>
        );
      })}
      {unassigned.length > 0 && (
        <div style={{ fontSize: 11, marginTop: 8, color: 'var(--text-secondary, #6b7280)' }}>
          {unassigned.length} jobs unassigned (capacity / time / skill / max_distance / max_travel_time).
        </div>
      )}
    </div>
  );
}

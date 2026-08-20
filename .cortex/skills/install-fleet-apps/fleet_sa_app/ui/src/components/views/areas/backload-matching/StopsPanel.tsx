'use client';

import { Assignment, Stop } from './helpers';

interface Props {
  assignment: Assignment | null;
  showWaitTimes?: boolean;
}

const KIND_STYLES: Record<Stop['kind'], { label: string; bg: string; fg: string; ring: string }> = {
  start:   { label: 'START',   bg: 'rgba(120,120,120,0.18)', fg: '#374151', ring: '#9ca3af' },
  pickup:  { label: 'PICKUP',  bg: 'rgba(245,158,11,0.18)',  fg: '#92400e', ring: '#f59e0b' },
  dropoff: { label: 'DROPOFF', bg: 'rgba(22,163,74,0.18)',   fg: '#065f46', ring: '#16a34a' },
  end:     { label: 'END',     bg: 'rgba(41,181,232,0.18)',  fg: '#0c4a6e', ring: '#29b5e8' },
  break:   { label: 'BREAK',   bg: 'rgba(168,85,247,0.18)',  fg: '#581c87', ring: '#a855f7' },
};

export default function StopsPanel({ assignment, showWaitTimes = true }: Props) {
  if (!assignment) return null;
  const stops: Stop[] = assignment.STOPS || [];
  const pickupCount = stops.filter((s) => s.kind === 'pickup').length;
  const dropoffCount = stops.filter((s) => s.kind === 'dropoff').length;
  const breakCount = stops.filter((s) => s.kind === 'break').length;
  const totalWait = stops.reduce((s, x) => s + (x.waitSec || 0), 0);
  return (
    <div style={{ marginTop: 12, border: '1px solid var(--border-default, #e5e7eb)', borderRadius: 8, padding: 12, background: 'rgba(255,255,255,0.4)' }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 12, marginBottom: 8, flexWrap: 'wrap' }}>
        <h3 style={{ fontSize: 13, margin: 0 }}>
          Stops &mdash; {assignment.TRAILER_ID}{' '}
          <span style={{ color: 'var(--text-secondary, #6b7280)', fontWeight: 400 }}>&rarr; {assignment.OFFER_ID}</span>
        </h3>
        <span style={{ fontSize: 11, color: 'var(--text-secondary, #6b7280)' }}>
          {stops.length} stops &middot; {pickupCount} pickup{pickupCount === 1 ? '' : 's'} &middot; {dropoffCount} dropoff{dropoffCount === 1 ? '' : 's'}
          {breakCount ? ` \u00b7 ${breakCount} break${breakCount === 1 ? '' : 's'}` : ''}
          {' \u00b7 '}empty {Math.round(assignment.EMPTY_KM)} km &middot; loaded {Math.round(assignment.LOADED_KM)} km
          {assignment.DETOUR_KM !== undefined ? ` \u00b7 detour +${Math.round(assignment.DETOUR_KM)} km` : ''}
          {assignment.TOUR_HRS ? ` \u00b7 ${assignment.TOUR_HRS.toFixed(1)} h` : ` \u00b7 ${assignment.SCORE.toFixed(0)}s`}
          {showWaitTimes && totalWait > 0 ? ` \u00b7 wait ${Math.round(totalWait / 60)} min total` : ''}
        </span>
        {assignment.NET_BENEFIT_USD !== undefined && (
          <span style={{
            fontSize: 11, padding: '2px 8px', borderRadius: 4, fontWeight: 600,
            background: assignment.NET_BENEFIT_USD >= 0 ? 'rgba(22,163,74,0.18)' : 'rgba(239,68,68,0.18)',
            color: assignment.NET_BENEFIT_USD >= 0 ? '#065f46' : '#991b1b',
          }}>
            Net ${Math.round(assignment.NET_BENEFIT_USD)}
          </span>
        )}
      </div>
      {!stops.length && <div style={{ fontSize: 11, color: 'var(--text-secondary, #6b7280)' }}>No stops recorded for this assignment.</div>}
      <div style={{ maxHeight: 320, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 4 }}>
        {stops.map((s, i) => {
          const ks = KIND_STYLES[s.kind];
          const longWait = (s.waitSec || 0) > 1800;
          return (
            <div key={i} style={{ display: 'grid', gridTemplateColumns: '32px 110px 1fr auto', alignItems: 'center', gap: 8, padding: '6px 8px', borderRadius: 4, border: `1px solid ${ks.ring}33`, background: ks.bg }}>
              <div style={{ width: 24, height: 24, borderRadius: '50%', background: '#fff', border: `2px solid ${ks.ring}`, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 11, fontWeight: 600, color: ks.fg }}>
                {i + 1}
              </div>
              <span style={{ fontSize: 10, fontWeight: 700, letterSpacing: 0.5, color: ks.fg }}>{ks.label}</span>
              <div style={{ fontSize: 12 }}>
                <b>{s.city || s.label}</b>
                {s.city && s.label && s.label !== s.city && <span style={{ color: 'var(--text-secondary, #6b7280)', marginLeft: 6, fontSize: 11 }}>{s.label}</span>}
                {s.kind === 'break' && s.serviceSec && (
                  <span style={{ color: ks.fg, marginLeft: 6, fontSize: 11 }}>&middot; {Math.round(s.serviceSec / 60)} min</span>
                )}
              </div>
              <div style={{ fontSize: 11, color: 'var(--text-secondary, #6b7280)', textAlign: 'right', display: 'flex', alignItems: 'center', gap: 6, justifyContent: 'flex-end' }}>
                {s.product && <span>{s.product}</span>}
                {s.weightKg ? <span>{s.product ? ' \u00b7 ' : ''}{(s.weightKg / 1000).toFixed(1)} t</span> : null}
                {showWaitTimes && s.waitSec && s.waitSec > 0 && (
                  <span style={{
                    fontSize: 10, padding: '1px 6px', borderRadius: 4,
                    background: longWait ? 'rgba(245,158,11,0.25)' : 'rgba(120,120,120,0.18)',
                    color: longWait ? '#92400e' : '#374151',
                  }}>
                    wait {Math.round(s.waitSec / 60)} min
                  </span>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

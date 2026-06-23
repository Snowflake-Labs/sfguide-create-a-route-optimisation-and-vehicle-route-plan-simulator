'use client';

import { useAppStore } from '@/lib/store';
import { useState, useRef, useEffect, useCallback } from 'react';

const PRESETS = [
  { label: 'Last 7 days', days: 7 },
  { label: 'Last 30 days', days: 30 },
  { label: 'Last 90 days', days: 90 },
  { label: 'Last 6 months', days: 180 },
  { label: 'Last 12 months', days: 365 },
  { label: 'All time', days: 0 },
];

function getDateLabel(value: unknown, endValue?: unknown): string {
  if (!value) return 'All time';
  const dateStr = String(value);
  if (endValue) {
    return `${dateStr} → ${String(endValue)}`;
  }
  const today = new Date();
  const target = new Date(dateStr);
  const diffDays = Math.round((today.getTime() - target.getTime()) / (1000 * 60 * 60 * 24));
  const match = PRESETS.find((p) => Math.abs(p.days - diffDays) < 3);
  if (match) return match.label;
  return `Since ${dateStr}`;
}

export function ContextBar() {
  const context = useAppStore((s) => s.context);
  const setContext = useAppStore((s) => s.setContext);
  const [open, setOpen] = useState(false);
  const [showCustom, setShowCustom] = useState(false);
  const [customStart, setCustomStart] = useState('');
  const [customEnd, setCustomEnd] = useState('');
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false);
        setShowCustom(false);
      }
    }
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, []);

  const applyCustom = useCallback(() => {
    if (customStart) {
      setContext('date_range_start', customStart);
      if (customEnd) {
        setContext('date_range_end', customEnd);
      }
    }
    setOpen(false);
    setShowCustom(false);
  }, [customStart, customEnd, setContext]);

  const dateRange = context.date_range_start;
  const dateRangeEnd = context.date_range_end;

  if (dateRange === undefined && Object.keys(context).filter(k => k !== 'date_range_start' && k !== 'date_range_end').length === 0) return null;

  return (
    <div
      style={{
        display: 'flex',
        gap: '12px',
        padding: '8px 16px',
        borderBottom: '1px solid var(--border-default, #e5e7eb)',
        backgroundColor: 'var(--surface-secondary, #f9fafb)',
        fontSize: '13px',
        flexWrap: 'wrap',
        alignItems: 'center',
      }}
    >
      {dateRange !== undefined && (
        <div ref={ref} style={{ position: 'relative' }}>
          <button
            onClick={() => setOpen(!open)}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: '6px',
              padding: '4px 10px',
              border: '1px solid var(--border-default, #d1d5db)',
              borderRadius: '6px',
              backgroundColor: 'white',
              cursor: 'pointer',
              fontSize: '13px',
              color: 'var(--text-primary, #111827)',
            }}
          >
            <span style={{ color: 'var(--text-secondary, #6b7280)' }}>📅</span>
            {getDateLabel(dateRange, dateRangeEnd)}
            <span style={{ color: 'var(--text-secondary, #6b7280)', fontSize: '10px' }}>▼</span>
          </button>
          {open && (
            <div
              style={{
                position: 'absolute',
                top: '100%',
                left: 0,
                marginTop: '4px',
                backgroundColor: 'white',
                border: '1px solid var(--border-default, #e5e7eb)',
                borderRadius: '8px',
                boxShadow: '0 4px 12px rgba(0,0,0,0.1)',
                zIndex: 100,
                minWidth: '160px',
                overflow: 'hidden',
              }}
            >
              {PRESETS.map((preset) => (
                <button
                  key={preset.label}
                  onClick={() => {
                    if (preset.days === 0) {
                      setContext('date_range_start', null);
                      setContext('date_range_end', null);
                    } else {
                      const d = new Date();
                      d.setDate(d.getDate() - preset.days);
                      setContext('date_range_start', d.toISOString().split('T')[0]);
                      setContext('date_range_end', null);
                    }
                    setOpen(false);
                    setShowCustom(false);
                  }}
                  style={{
                    display: 'block',
                    width: '100%',
                    padding: '8px 14px',
                    border: 'none',
                    backgroundColor: 'transparent',
                    textAlign: 'left',
                    cursor: 'pointer',
                    fontSize: '13px',
                    color: 'var(--text-primary, #111827)',
                  }}
                  onMouseOver={(e) => (e.currentTarget.style.backgroundColor = 'var(--surface-secondary, #f3f4f6)')}
                  onMouseOut={(e) => (e.currentTarget.style.backgroundColor = 'transparent')}
                >
                  {preset.label}
                </button>
              ))}
              <div style={{ borderTop: '1px solid var(--border-default, #e5e7eb)', margin: '4px 0' }} />
              {!showCustom ? (
                <button
                  onClick={() => setShowCustom(true)}
                  style={{
                    display: 'block',
                    width: '100%',
                    padding: '8px 14px',
                    border: 'none',
                    backgroundColor: 'transparent',
                    textAlign: 'left',
                    cursor: 'pointer',
                    fontSize: '13px',
                    color: 'var(--text-primary, #111827)',
                  }}
                  onMouseOver={(e) => (e.currentTarget.style.backgroundColor = 'var(--surface-secondary, #f3f4f6)')}
                  onMouseOut={(e) => (e.currentTarget.style.backgroundColor = 'transparent')}
                >
                  Custom range…
                </button>
              ) : (
                <div style={{ padding: '8px 14px', display: 'flex', flexDirection: 'column', gap: '8px' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                    <label style={{ fontSize: '12px', color: 'var(--text-secondary, #6b7280)', minWidth: '32px' }}>From</label>
                    <input
                      type="date"
                      value={customStart}
                      onChange={(e) => setCustomStart(e.target.value)}
                      style={{ flex: 1, padding: '4px 6px', border: '1px solid #d1d5db', borderRadius: '4px', fontSize: '12px' }}
                    />
                  </div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                    <label style={{ fontSize: '12px', color: 'var(--text-secondary, #6b7280)', minWidth: '32px' }}>To</label>
                    <input
                      type="date"
                      value={customEnd}
                      onChange={(e) => setCustomEnd(e.target.value)}
                      style={{ flex: 1, padding: '4px 6px', border: '1px solid #d1d5db', borderRadius: '4px', fontSize: '12px' }}
                    />
                  </div>
                  <button
                    onClick={applyCustom}
                    disabled={!customStart}
                    style={{
                      padding: '6px 12px',
                      backgroundColor: customStart ? 'var(--interactive-primary, #2563eb)' : '#d1d5db',
                      color: 'white',
                      border: 'none',
                      borderRadius: '4px',
                      cursor: customStart ? 'pointer' : 'default',
                      fontSize: '12px',
                      fontWeight: 500,
                    }}
                  >
                    Apply
                  </button>
                </div>
              )}
            </div>
          )}
        </div>
      )}
      {Object.entries(context)
        .filter(([key]) => key !== 'date_range_start' && key !== 'date_range_end')
        .map(([key, value]) => (
          <div key={key} style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
            <span style={{ color: 'var(--text-secondary, #6b7280)', fontWeight: 500 }}>{key}:</span>
            <span style={{ color: 'var(--text-primary, #111827)' }}>{String(value)}</span>
          </div>
        ))}
    </div>
  );
}

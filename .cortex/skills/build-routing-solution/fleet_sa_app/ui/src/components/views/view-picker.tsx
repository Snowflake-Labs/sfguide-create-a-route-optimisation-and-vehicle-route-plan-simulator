'use client';

import { useState, useMemo, useEffect, useRef } from 'react';
import { useAppStore } from '@/lib/store';
import { viewRegistry } from '@/lib/view-registry';

export function ViewPicker() {
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(false);
  const [mounted, setMounted] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const activeViewId = useAppStore((s) => s.panel.activeViewId);
  const showView = useAppStore((s) => s.showView);
  const viewsVersion = useAppStore((s) => s.viewsVersion);
  const selectedRole = useAppStore((s) => s.selectedRole);

  useEffect(() => { setMounted(true); }, []);

  useEffect(() => {
    if (!open) return;
    function handleClick(e: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
        setQuery('');
      }
    }
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, [open]);

  const views = useMemo(() => {
    return query ? viewRegistry.search(query, selectedRole) : viewRegistry.list(selectedRole);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query, viewsVersion, selectedRole]);

  const activeView = activeViewId ? viewRegistry.get(activeViewId) : undefined;

  // If a role switch makes the active view disallowed, redirect to the first
  // view the selected role can see (keeps the panel from rendering a hidden view).
  useEffect(() => {
    if (!activeViewId) return;
    const allowed = viewRegistry.list(selectedRole);
    if (!allowed.some((v) => v.id === activeViewId) && allowed.length > 0) {
      showView(allowed[0].id);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedRole, viewsVersion, activeViewId]);

  if (!mounted || viewsVersion === 0) {
    return null;
  }

  if (viewRegistry.list().length === 0) {
    return (
      <div style={{ fontSize: '13px', color: 'var(--text-tertiary, #9ca3af)' }}>
        No views available
      </div>
    );
  }

  return (
    <div ref={containerRef} style={{ position: 'relative' }}>
      <button
        onClick={() => setOpen(!open)}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: '8px',
          width: '100%',
          padding: '6px 10px',
          borderRadius: '8px',
          border: '1px solid var(--border-default, #e5e7eb)',
          backgroundColor: 'var(--surface-primary, #fff)',
          cursor: 'pointer',
          fontSize: '13px',
          textAlign: 'left',
          color: 'var(--text-primary, #111827)',
        }}
      >
        <span style={{ fontSize: '14px' }}>🔍</span>
        <span style={{ flex: 1 }}>{activeView?.label || 'Search views...'}</span>
        <span style={{ fontSize: '10px', color: 'var(--text-tertiary, #9ca3af)' }}>▼</span>
      </button>
      {open && (
        <div
          style={{
            position: 'absolute',
            top: '100%',
            left: 0,
            right: 0,
            marginTop: '4px',
            borderRadius: '8px',
            border: '1px solid var(--border-default, #e5e7eb)',
            backgroundColor: 'var(--surface-primary, #fff)',
            boxShadow: '0 4px 12px rgba(0,0,0,0.1)',
            zIndex: 100,
            maxHeight: '300px',
            overflow: 'auto',
          }}
        >
          <div style={{ padding: '8px' }}>
            <input
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search views..."
              autoFocus
              style={{
                width: '100%',
                padding: '6px 8px',
                border: '1px solid var(--border-default, #e5e7eb)',
                borderRadius: '6px',
                fontSize: '13px',
                outline: 'none',
                boxSizing: 'border-box',
              }}
            />
          </div>
          {views.map((v) => (
            <button
              key={v.id}
              onClick={() => {
                showView(v.id);
                setOpen(false);
                setQuery('');
              }}
              style={{
                display: 'block',
                width: '100%',
                padding: '8px 12px',
                border: 'none',
                backgroundColor: v.id === activeViewId ? 'var(--surface-accent, #e0edff)' : 'transparent',
                cursor: 'pointer',
                textAlign: 'left',
                fontSize: '13px',
              }}
            >
              <div style={{ fontWeight: 500, color: 'var(--text-primary, #111827)' }}>{v.label}</div>
              <div style={{ fontSize: '12px', color: 'var(--text-secondary, #6b7280)', marginTop: '2px' }}>
                {v.description}
              </div>
            </button>
          ))}
          {views.length === 0 && (
            <div style={{ padding: '12px', fontSize: '13px', color: 'var(--text-tertiary, #9ca3af)', textAlign: 'center' }}>
              No matching views
            </div>
          )}
        </div>
      )}
    </div>
  );
}

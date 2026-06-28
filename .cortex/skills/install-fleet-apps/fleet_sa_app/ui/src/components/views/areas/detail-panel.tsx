'use client';

// DetailPanelArea — a reusable, config-driven slide-over drawer that opens when a
// selection viewState key (e.g. `selected_entity`) becomes non-null and fills with
// parameterized sub-queries about the selected item. Any view can add one via
// app-views.json with `"component": "DetailPanel"` and `config.position: "drawer"`;
// no bespoke React per view. Renders nothing into the grid flow — it positions
// itself absolutely over the view (the renderer places drawer areas outside the
// CSS grid). Reuses the shared primitives in detail-sections.tsx.

import { useCallback } from 'react';
import { useViewData } from '@/hooks/use-view-data';
import { useAppStore } from '@/lib/store';
import { useDisplayConfig, interpolateTokens } from '@/lib/display-config';
import {
  fmtValue,
  KVRow,
  RelatedTableSection,
  type PropertyDef,
  type SectionDef,
} from './detail-sections';

// ── Config types ────────────────────────────────────────────────────────────

interface DetailActionDef {
  label: string;
  view: string;                       // target view id to navigate to
  carry?: Record<string, string>;     // targetViewStateKey -> header row field
  style?: 'primary' | 'secondary';
}

export interface DetailPanelConfig {
  triggerKey: string;                 // viewState key watched for show/hide (e.g. "selected_entity")
  title?: string;                     // static fallback title
  titleField?: string;                // header row field used as the title
  subtitleFields?: string[];          // header row fields joined with " · " as subtitle
  properties?: PropertyDef[];         // KV rows rendered from the header row
  sections?: Extract<SectionDef, { type: 'related_table' }>[]; // parameterized sub-queries
  actions?: DetailActionDef[];        // cross-view deep links
  emptyMessage?: string;              // shown when the header query returns no row
  width?: number;                     // drawer width in px (default 380)
}

interface DetailPanelAreaProps {
  areaConfig: {
    data?: { query?: string; params?: Record<string, string> }; // header (single-row) query
    config: DetailPanelConfig;
  };
}

// ── Open-state body (mounted only when a selection is active, so the section
// sub-queries don't fire while the drawer is closed). ────────────────────────

function DetailPanelBody({
  headerQuery,
  headerParams,
  config,
}: {
  headerQuery?: string;
  headerParams?: Record<string, string>;
  config: DetailPanelConfig;
}) {
  const display = useDisplayConfig();
  const showView = useAppStore((s) => s.showView);
  const { data, loading, error } = useViewData(headerQuery, headerParams);
  const row = data?.rows[0] as Record<string, unknown> | undefined;

  const tr = useCallback((t?: string) => (t ? interpolateTokens(t, display) : t), [display]);

  const title = row && config.titleField
    ? String(row[config.titleField] ?? config.title ?? '')
    : tr(config.title) ?? '';
  const subtitleParts = row
    ? (config.subtitleFields ?? []).map((f) => row[f]).filter((v) => v != null && v !== '').map(String)
    : [];

  const runAction = useCallback((action: DetailActionDef) => {
    const state: Record<string, unknown> = {};
    if (action.carry && row) {
      for (const [stateKey, field] of Object.entries(action.carry)) {
        const v = row[field];
        if (v != null && v !== '') state[stateKey] = v;
      }
    }
    showView(action.view, state);
  }, [row, showView]);

  return (
    <>
      {/* Sticky header: title + subtitle + actions */}
      <div style={{ padding: '14px 16px', borderBottom: '1px solid var(--border-default, #e5e7eb)', flexShrink: 0 }}>
        <h2 style={{ margin: 0, fontSize: '15px', fontWeight: 700, color: 'var(--text-primary, #111827)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {title || '—'}
        </h2>
        {subtitleParts.length > 0 && (
          <div style={{ fontSize: '12.5px', color: 'var(--text-secondary, #6b7280)', marginTop: '3px' }}>
            {subtitleParts.join(' · ')}
          </div>
        )}
        {(config.actions ?? []).length > 0 && (
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px', marginTop: '10px' }}>
            {config.actions!.map((action) => (
              <button
                key={action.label}
                onClick={() => runAction(action)}
                style={{
                  padding: '4px 10px', borderRadius: '6px', fontSize: '12px', fontWeight: 600, cursor: 'pointer',
                  border: '1px solid',
                  backgroundColor: action.style === 'primary' ? 'var(--color-accent, #2563eb)' : 'white',
                  color: action.style === 'primary' ? 'white' : 'var(--text-primary, #374151)',
                  borderColor: action.style === 'primary' ? 'var(--color-accent, #2563eb)' : 'var(--border-default, #e5e7eb)',
                  whiteSpace: 'nowrap',
                }}
              >
                {tr(action.label)}
              </button>
            ))}
          </div>
        )}
      </div>

      {/* Scrollable body: properties + sub-query sections */}
      <div style={{ flex: 1, overflow: 'auto', padding: '16px' }}>
        {loading && !row ? (
          <div>
            {Array.from({ length: 4 }).map((_, i) => (
              <div key={i} style={{ height: '30px', marginBottom: '8px', borderRadius: '4px', backgroundColor: 'var(--surface-secondary, #f3f4f6)' }} />
            ))}
          </div>
        ) : error ? (
          <div style={{ color: 'var(--text-error, #dc2626)', fontSize: '13px' }}>Error: {error}</div>
        ) : !row ? (
          <div style={{ color: 'var(--text-secondary, #6b7280)', fontSize: '13px' }}>{config.emptyMessage ?? 'No data for this selection.'}</div>
        ) : (
          <>
            {(config.properties ?? []).length > 0 && (
              <div style={{ marginBottom: '24px', border: '1px solid var(--border-default, #e5e7eb)', borderRadius: '6px', padding: '4px 12px' }}>
                {config.properties!.map((prop) => {
                  const val = row[prop.field];
                  if (prop.conditional && (val === null || val === undefined || val === '')) return null;
                  const display = prop.link_view ? (
                    <button
                      onClick={() => showView(prop.link_view!, { id: String(row[prop.id_field ?? prop.field] ?? '') })}
                      style={{ background: 'none', border: 'none', padding: 0, cursor: 'pointer', color: 'var(--text-accent, #2563eb)', fontSize: '13px', textDecoration: 'underline' }}
                    >
                      {fmtValue(val, prop.format)}
                    </button>
                  ) : fmtValue(val, prop.format);
                  return <KVRow key={prop.field} label={tr(prop.label) ?? prop.label} value={display} />;
                })}
              </div>
            )}

            {(config.sections ?? []).map((section, idx) => (
              <RelatedTableSection
                key={idx}
                section={{ ...section, title: tr(section.title) }}
                params={section.params}
                showViewFn={showView}
              />
            ))}
          </>
        )}
      </div>
    </>
  );
}

// ── Area component (always mounted; controls the slide-over chrome) ──────────

export function DetailPanelArea({ areaConfig }: DetailPanelAreaProps) {
  const { data: areaData, config } = areaConfig;
  const triggerKey = config.triggerKey;
  const selectionValue = useAppStore((s) => s.panel.viewState[triggerKey]);
  const updateViewState = useAppStore((s) => s.updateViewState);
  const display = useDisplayConfig();

  const open = selectionValue != null && selectionValue !== '';
  const width = config.width ?? 380;

  const close = useCallback(() => updateViewState({ [triggerKey]: null }), [updateViewState, triggerKey]);

  return (
    <aside
      aria-hidden={!open}
      style={{
        position: 'absolute', top: 0, right: 0, bottom: 0, width: `${width}px`, maxWidth: '92vw',
        backgroundColor: 'var(--surface-primary, #fff)',
        borderLeft: '1px solid var(--border-default, #e5e7eb)',
        boxShadow: open ? '-8px 0 24px rgba(0,0,0,0.12)' : 'none',
        transform: open ? 'translateX(0)' : 'translateX(105%)',
        transition: 'transform 0.25s ease',
        zIndex: 30,
        display: 'flex', flexDirection: 'column',
        pointerEvents: open ? 'auto' : 'none',
      }}
    >
      {/* Close button overlaps the body header */}
      <button
        onClick={close}
        aria-label="Close detail panel"
        style={{
          position: 'absolute', top: '10px', right: '10px', zIndex: 1,
          width: '26px', height: '26px', borderRadius: '6px', cursor: 'pointer',
          border: '1px solid var(--border-default, #e5e7eb)', backgroundColor: 'var(--surface-secondary, #f3f4f6)',
          color: 'var(--text-secondary, #6b7280)', fontSize: '15px', lineHeight: 1, padding: 0,
        }}
      >
        ×
      </button>
      {open && (
        <DetailPanelBody
          headerQuery={areaData?.query}
          headerParams={areaData?.params}
          config={config}
        />
      )}
      {!open && (
        // Keep the title bar visually present off-canvas isn't needed; render a
        // tiny placeholder so the empty aside has no flash of unstyled content.
        <span style={{ display: 'none' }} aria-hidden>{interpolateTokens(config.title ?? '', display)}</span>
      )}
    </aside>
  );
}

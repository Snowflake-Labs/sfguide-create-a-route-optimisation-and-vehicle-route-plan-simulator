'use client';

import { useState, useCallback } from 'react';
import { useViewData } from '@/hooks/use-view-data';
import { useAppStore } from '@/lib/store';
import { viewRegistry } from '@/lib/view-registry';
import type { Operation } from '@/app/api/write/route';

// ── Config type definitions ────────────────────────────────────────────────────

interface StatusTransitionDef {
  label: string;
  next: string;
  danger?: boolean;
}

interface PropertyDef {
  field: string;
  label: string;
  format?: 'number' | 'currency' | 'datetime' | 'date' | 'text';
  link_view?: string;   // navigate to this view on click
  id_field?: string;    // which row field provides the ID for link_view
  conditional?: boolean; // hide row when field is null/empty
}

type SectionDef =
  | { type: 'text';              field: string; title?: string; conditional?: boolean }
  | { type: 'code';              field: string; title?: string; conditional?: boolean }
  | { type: 'dynamic_sql_table'; field: string; title?: string; limit?: number }
  | { type: 'related_table';     title?: string; query: string; columns: ColumnDef[]; link?: { label: string; view: string } };

interface ColumnDef {
  field: string;
  header: string;
  format?: string;
}

interface ActionDef {
  id: string;
  label: string;
  style?: 'primary' | 'secondary' | 'danger';
  condition_status?: string[];     // show only when entity status is in this list
  workflow_type?: string;
  workflow_result_view?: string;   // navigate here after workflow completes
  requires_deps_clear?: boolean;   // hide until all dependency_check entries are active
}

interface DependencyDef {
  field: string;          // FK field on the main entity (e.g. target_audience_id)
  status_field: string;   // joined field with dep's status (e.g. audience_status)
  name_field: string;     // joined field with dep's name
  version_field: string;  // joined field with dep's version
  entity: string;         // manifest key for the dep entity (e.g. 'Audience')
  detail_view: string;    // view ID for navigating to the dep's detail view
}

export interface EntityDetailConfig {
  entity: string;         // manifest key — used in /api/write calls
  pk_field: string;       // row field that holds the primary key value
  name_field: string;     // row field used as the page title
  parent_view: string;    // view ID for the back-nav button
  subtitle_fields?: string[];
  status_field?: string;
  status_colors?: Record<string, { bg: string; text: string }>;
  status_transitions?: Record<string, StatusTransitionDef[]>;
  properties: PropertyDef[];
  sections?: SectionDef[];
  actions?: ActionDef[];
  dependency_check?: DependencyDef[];
  // noPad handled by view-renderer; not read here
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function fmtValue(val: unknown, format?: string): string {
  if (val === null || val === undefined || val === '') return '—';
  const s = String(val);
  if (!format || format === 'text') return s;
  if (format === 'number') {
    const n = Number(val);
    return isNaN(n) ? s : n.toLocaleString();
  }
  if (format === 'currency') {
    const n = Number(val);
    return isNaN(n) ? s : '$' + n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }
  if (format === 'datetime' || format === 'date') {
    try {
      const d = new Date(s);
      if (isNaN(d.getTime())) return s;
      return format === 'date'
        ? d.toLocaleDateString(undefined, { dateStyle: 'medium' })
        : d.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
    } catch { return s; }
  }
  return s;
}

// ── Shared primitives ─────────────────────────────────────────────────────────

function KVRow({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div style={{ display: 'flex', gap: '12px', padding: '8px 0', borderBottom: '1px solid var(--border-default, #e5e7eb)' }}>
      <div style={{ width: '160px', flexShrink: 0, color: 'var(--text-secondary, #6b7280)', fontSize: '13px', fontWeight: 500 }}>{label}</div>
      <div style={{ color: 'var(--text-primary, #111827)', fontSize: '13px', wordBreak: 'break-word', flex: 1 }}>{value ?? '—'}</div>
    </div>
  );
}

function SectionHeading({ title, note }: { title?: string; note?: string }) {
  if (!title) return null;
  return (
    <h3 style={{ margin: '0 0 12px', fontSize: '14px', fontWeight: 600, color: 'var(--text-primary, #111827)' }}>
      {title}
      {note && <span style={{ marginLeft: '8px', fontSize: '12px', fontWeight: 400, color: 'var(--text-secondary, #6b7280)' }}>{note}</span>}
    </h3>
  );
}

function Skeleton({ rows = 3 }: { rows?: number }) {
  return (
    <div style={{ padding: '16px' }}>
      {Array.from({ length: rows }).map((_, i) => (
        <div key={i} style={{ height: '28px', marginBottom: '6px', borderRadius: '4px', backgroundColor: 'var(--surface-secondary, #f3f4f6)' }} />
      ))}
    </div>
  );
}

// ── Section components (each has its own hooks so they can call useViewData) ──

// Runs row[field] as a SQL query — used for "Live Membership" in audience detail
function DynamicSqlSection({ sql, title, limit }: { sql: string | null; title?: string; limit?: number }) {
  const wrappedSql = sql ? `SELECT * FROM (${sql}) AS _t LIMIT ${limit ?? 200}` : undefined;
  const { data, loading, error, refetch } = useViewData(wrappedSql);

  return (
    <div style={{ marginBottom: '28px' }}>
      <SectionHeading title={title} note="— evaluated from definition SQL" />
      <div style={{ border: '1px solid var(--border-default, #e5e7eb)', borderRadius: '6px', overflow: 'hidden' }}>
        {!sql ? (
          <div style={{ padding: '12px', color: 'var(--text-secondary, #6b7280)', fontSize: '13px' }}>No SQL — membership cannot be computed.</div>
        ) : loading ? (
          <Skeleton />
        ) : error ? (
          <div style={{ padding: '12px 16px' }}>
            <div style={{ color: 'var(--text-error, #dc2626)', fontSize: '13px', marginBottom: '8px' }}>Error: {error}</div>
            <button onClick={refetch} style={{ padding: '4px 12px', fontSize: '12px', borderRadius: '4px', border: '1px solid var(--border-default, #e5e7eb)', cursor: 'pointer', backgroundColor: 'white' }}>Retry</button>
          </div>
        ) : !data?.rows.length ? (
          <div style={{ padding: '12px', color: 'var(--text-secondary, #6b7280)', fontSize: '13px' }}>No members found.</div>
        ) : (
          <AutoTable
            columns={data.columns.map(c => ({ field: c.key, header: c.label }))}
            rows={data.rows}
            totalRows={data.totalRows}
          />
        )}
      </div>
    </div>
  );
}

// Runs a static parameterized sub-query — used for sub-lists like Activation History
function RelatedTableSection({ section, showViewFn }: { section: Extract<SectionDef, { type: 'related_table' }>; showViewFn: (id: string) => void }) {
  const { data, loading, error } = useViewData(section.query, { id: 'viewState.id' });

  return (
    <div style={{ marginBottom: '28px' }}>
      <SectionHeading title={section.title} />
      <div style={{ border: '1px solid var(--border-default, #e5e7eb)', borderRadius: '6px', overflow: 'hidden' }}>
        {loading ? (
          <Skeleton />
        ) : error ? (
          <div style={{ padding: '12px', color: 'var(--text-error, #dc2626)', fontSize: '13px' }}>Error: {error}</div>
        ) : !data?.rows.length ? (
          <div style={{ padding: '12px', color: 'var(--text-secondary, #6b7280)', fontSize: '13px' }}>No records found.</div>
        ) : (
          <AutoTable columns={section.columns} rows={data.rows} />
        )}
      </div>
      {section.link && (
        <button
          onClick={() => showViewFn(section.link!.view)}
          style={{ marginTop: '8px', background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-accent, #2563eb)', fontSize: '13px', padding: 0 }}
        >
          {section.link.label}
        </button>
      )}
    </div>
  );
}

// Generic table renderer used by both section types above
function AutoTable({ columns, rows, totalRows }: { columns: ColumnDef[]; rows: Record<string, unknown>[]; totalRows?: number }) {
  const displayed = rows.length;
  const total = totalRows ?? displayed;
  return (
    <div style={{ overflow: 'auto' }}>
      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '13px' }}>
        <thead>
          <tr>
            {columns.map(col => (
              <th key={col.field} style={{ padding: '8px 12px', textAlign: 'left', fontWeight: 600, backgroundColor: 'var(--surface-secondary, #f3f4f6)', borderBottom: '2px solid var(--border-default, #e5e7eb)', whiteSpace: 'nowrap', position: 'sticky', top: 0, zIndex: 1 }}>
                {col.header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, i) => (
            <tr key={i} style={{ borderBottom: '1px solid var(--border-default, #e5e7eb)' }}>
              {columns.map(col => (
                <td key={col.field} style={{ padding: '6px 12px', whiteSpace: 'nowrap', color: 'var(--text-primary, #111827)' }}>
                  {fmtValue(row[col.field], col.format)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      {total > displayed && (
        <div style={{ padding: '8px', fontSize: '12px', color: 'var(--text-secondary, #6b7280)', textAlign: 'center' }}>
          Showing {displayed} of {total.toLocaleString()}
        </div>
      )}
    </div>
  );
}

// ── Main area component ────────────────────────────────────────────────────────

interface EntityDetailAreaProps {
  areaConfig: {
    data: { query: string; params?: Record<string, string> };
    config: EntityDetailConfig & { noPad?: boolean };
  };
}

export function EntityDetailArea({ areaConfig }: EntityDetailAreaProps) {
  const { data: areaData, config } = areaConfig;
  const showView = useAppStore(s => s.showView);
  const bumpViewsVersion = useAppStore(s => s.bumpViewsVersion);

  const { data, loading, error } = useViewData(
    areaData.query,
    areaData.params as Record<string, string> | undefined,
  );

  const [statusLoading, setStatusLoading] = useState(false);
  const [statusError, setStatusError] = useState<string | null>(null);
  const [actionLoading, setActionLoading] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [depApproving, setDepApproving] = useState(false);
  const [depError, setDepError] = useState<string | null>(null);

  const row = data?.rows[0] as Record<string, unknown> | undefined;
  const entityId = row ? String(row[config.pk_field] ?? '') : '';
  const currentStatus = row && config.status_field ? String(row[config.status_field] ?? '') : '';
  const statusColors = config.status_colors ?? {};
  const statusStyle = statusColors[currentStatus] ?? { bg: '#f3f4f6', text: '#6b7280' };
  const transitions = config.status_transitions?.[currentStatus] ?? [];

  const draftDeps = row
    ? (config.dependency_check ?? []).filter(dep => {
        const depId = row[dep.field];
        const depStatus = String(row[dep.status_field] ?? '');
        return depId && depStatus !== 'active';
      })
    : [];

  const handleStatusChange = useCallback(async (nextStatus: string) => {
    if (!row) return;
    setStatusLoading(true);
    setStatusError(null);
    try {
      const res = await fetch('/api/write', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          entity: config.entity,
          operation: 'update' satisfies Operation,
          record_id: entityId,
          fields: { status: nextStatus },
          expected_version: Number(row.version ?? 1),
        }),
      });
      const result = await res.json() as { success: boolean; error?: string };
      if (!result.success) throw new Error(result.error ?? 'Update failed');
      bumpViewsVersion();
    } catch (e) {
      setStatusError(e instanceof Error ? e.message : 'Status update failed');
    } finally {
      setStatusLoading(false);
    }
  }, [row, entityId, config.entity, bumpViewsVersion]);

  const handleApproveAll = useCallback(async () => {
    if (!row || draftDeps.length === 0) return;
    setDepApproving(true);
    setDepError(null);
    try {
      for (const dep of draftDeps) {
        const res = await fetch('/api/write', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            entity: dep.entity,
            operation: 'update' satisfies Operation,
            record_id: String(row[dep.field] ?? ''),
            fields: { status: 'active' },
            expected_version: Number(row[dep.version_field] ?? 1),
          }),
        });
        const result = await res.json() as { success: boolean; error?: string };
        if (!result.success) throw new Error(result.error ?? 'Approval failed');
      }
      bumpViewsVersion();
    } catch (e) {
      setDepError(e instanceof Error ? e.message : 'Approval failed');
    } finally {
      setDepApproving(false);
    }
  }, [row, draftDeps, bumpViewsVersion]);

  const handleApproveSingle = useCallback(async (dep: DependencyDef) => {
    if (!row) return;
    setDepApproving(true);
    setDepError(null);
    try {
      const res = await fetch('/api/write', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          entity: dep.entity,
          operation: 'update' satisfies Operation,
          record_id: String(row[dep.field] ?? ''),
          fields: { status: 'active' },
          expected_version: Number(row[dep.version_field] ?? 1),
        }),
      });
      const result = await res.json() as { success: boolean; error?: string };
      if (!result.success) throw new Error(result.error ?? 'Approval failed');
      bumpViewsVersion();
    } catch (e) {
      setDepError(e instanceof Error ? e.message : 'Approval failed');
    } finally {
      setDepApproving(false);
    }
  }, [row, bumpViewsVersion]);

  const handleAction = useCallback(async (action: ActionDef) => {
    if (!row) return;
    setActionLoading(action.id);
    setActionError(null);
    try {
      if (action.workflow_type) {
        const res = await fetch('/api/workflow/execute', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            workflow_type: action.workflow_type,
            params: { [config.pk_field]: entityId },
          }),
        });
        const result = await res.json() as { instance_id?: string; error?: string };
        if (result.error) throw new Error(result.error);
        if (action.workflow_result_view && result.instance_id) {
          showView(action.workflow_result_view, { selectedInstanceId: result.instance_id });
        }
      }
    } catch (e) {
      setActionError(e instanceof Error ? e.message : 'Action failed');
    } finally {
      setActionLoading(null);
    }
  }, [row, entityId, config.pk_field, showView]);

  // ── Loading / error / empty states ────────────────────────────────────────

  if (loading) {
    return (
      <div style={{ padding: '24px' }}>
        {Array.from({ length: 5 }).map((_, i) => (
          <div key={i} style={{ height: '36px', marginBottom: '8px', borderRadius: '4px', backgroundColor: 'var(--surface-secondary, #f3f4f6)' }} />
        ))}
      </div>
    );
  }

  if (error) return <div style={{ padding: '24px', color: 'var(--text-error, #dc2626)', fontSize: '13px' }}>Error: {error}</div>;
  if (!row)  return <div style={{ padding: '24px', color: 'var(--text-secondary, #6b7280)', fontSize: '13px' }}>Record not found.</div>;

  // ── Derived display values ────────────────────────────────────────────────

  const entityName = String(row[config.name_field] ?? '');
  const subtitleParts = (config.subtitle_fields ?? []).map(f => row[f]).filter(Boolean).map(String);
  const parentLabel = viewRegistry.get(config.parent_view)?.label ?? 'Back';

  const visibleActions = (config.actions ?? []).filter(a =>
    !a.condition_status || a.condition_status.includes(currentStatus),
  );
  // Action button is only shown when deps are clear (if required)
  const canRunAction = (a: ActionDef) => !a.requires_deps_clear || draftDeps.length === 0;

  // ── Render ────────────────────────────────────────────────────────────────

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', overflow: 'hidden' }}>

      {/* ── Header ── */}
      <div style={{ padding: '16px 20px', borderBottom: '1px solid var(--border-default, #e5e7eb)', display: 'flex', alignItems: 'flex-start', gap: '12px', flexShrink: 0, flexWrap: 'wrap' }}>
        <button
          onClick={() => showView(config.parent_view)}
          style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-secondary, #6b7280)', fontSize: '13px', padding: '2px 4px', borderRadius: '4px', whiteSpace: 'nowrap', marginTop: '3px' }}
        >
          ← {parentLabel}
        </button>

        <div style={{ flex: 1, minWidth: 0 }}>
          <h2 style={{ margin: 0, fontSize: '16px', fontWeight: 700, color: 'var(--text-primary, #111827)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {entityName}
          </h2>
          {subtitleParts.length > 0 && (
            <div style={{ fontSize: '13px', color: 'var(--text-secondary, #6b7280)', marginTop: '2px' }}>
              {subtitleParts.join(' · ')}
            </div>
          )}
        </div>

        {config.status_field && (
          <span style={{ padding: '3px 10px', borderRadius: '12px', fontSize: '12px', fontWeight: 600, backgroundColor: statusStyle.bg, color: statusStyle.text, whiteSpace: 'nowrap', marginTop: '3px' }}>
            {currentStatus}
          </span>
        )}

        {transitions.map(t => (
          <button
            key={t.next}
            onClick={() => handleStatusChange(t.next)}
            disabled={statusLoading}
            style={{ padding: '3px 10px', borderRadius: '6px', fontSize: '12px', fontWeight: 500, cursor: statusLoading ? 'not-allowed' : 'pointer', border: '1px solid var(--border-default, #e5e7eb)', backgroundColor: t.danger ? '#fff7f7' : 'white', color: t.danger ? '#dc2626' : 'var(--text-primary, #374151)', opacity: statusLoading ? 0.6 : 1, whiteSpace: 'nowrap' }}
          >
            {statusLoading ? '…' : t.label}
          </button>
        ))}

        {visibleActions.filter(canRunAction).map(action => (
          <button
            key={action.id}
            onClick={() => handleAction(action)}
            disabled={!!actionLoading}
            style={{
              padding: '4px 12px', borderRadius: '6px', fontSize: '12px', fontWeight: 600,
              cursor: actionLoading ? 'not-allowed' : 'pointer',
              border: '1px solid',
              backgroundColor: action.style === 'primary' ? 'var(--color-accent, #2563eb)' : action.style === 'danger' ? '#fff7f7' : 'white',
              color: action.style === 'primary' ? 'white' : action.style === 'danger' ? '#dc2626' : 'var(--text-primary, #374151)',
              borderColor: action.style === 'primary' ? 'var(--color-accent, #2563eb)' : action.style === 'danger' ? '#dc2626' : 'var(--border-default, #e5e7eb)',
              opacity: actionLoading ? 0.6 : 1, whiteSpace: 'nowrap',
            }}
          >
            {actionLoading === action.id ? '…' : action.label}
          </button>
        ))}

        {(statusError || actionError) && (
          <span style={{ fontSize: '12px', color: '#dc2626', width: '100%' }}>{statusError ?? actionError}</span>
        )}
      </div>

      {/* ── Scrollable body ── */}
      <div style={{ flex: 1, overflow: 'auto', padding: '20px' }}>

        {/* Draft dependency panel */}
        {draftDeps.length > 0 && visibleActions.some(a => a.requires_deps_clear) && (
          <div style={{ marginBottom: '20px', padding: '16px', backgroundColor: '#fffbeb', border: '1px solid #fcd34d', borderRadius: '8px' }}>
            <div style={{ fontSize: '13px', fontWeight: 600, color: '#92400e', marginBottom: '12px' }}>
              Before activating, approve these dependencies:
            </div>
            {depError && <div style={{ fontSize: '12px', color: '#dc2626', marginBottom: '8px' }}>{depError}</div>}
            <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
              {draftDeps.map(dep => {
                const depName = String(row[dep.name_field] ?? dep.entity);
                const depStatus = String(row[dep.status_field] ?? '');
                const depId = String(row[dep.field] ?? '');
                return (
                  <div key={dep.field} style={{ display: 'flex', alignItems: 'center', gap: '8px', padding: '8px 10px', backgroundColor: 'white', borderRadius: '6px', border: '1px solid #fcd34d' }}>
                    <span style={{ fontSize: '12px', fontWeight: 500, color: '#374151', flex: 1 }}>
                      {dep.entity}: <strong>{depName}</strong> — <span style={{ color: '#6b7280' }}>{depStatus}</span>
                    </span>
                    <button
                      onClick={() => showView(dep.detail_view, { id: depId })}
                      style={{ padding: '2px 8px', fontSize: '12px', borderRadius: '4px', border: '1px solid var(--border-default, #e5e7eb)', cursor: 'pointer', backgroundColor: 'white', color: 'var(--text-secondary, #6b7280)', whiteSpace: 'nowrap' }}
                    >
                      View →
                    </button>
                    <button
                      onClick={() => handleApproveSingle(dep)}
                      disabled={depApproving}
                      style={{ padding: '2px 8px', fontSize: '12px', borderRadius: '4px', border: '1px solid #10b981', cursor: depApproving ? 'not-allowed' : 'pointer', backgroundColor: '#ecfdf5', color: '#065f46', opacity: depApproving ? 0.6 : 1, whiteSpace: 'nowrap' }}
                    >
                      {depApproving ? '…' : 'Approve'}
                    </button>
                  </div>
                );
              })}
            </div>
            {draftDeps.length > 1 && (
              <button
                onClick={handleApproveAll}
                disabled={depApproving}
                style={{ marginTop: '10px', padding: '5px 14px', fontSize: '12px', fontWeight: 600, borderRadius: '6px', border: '1px solid #10b981', cursor: depApproving ? 'not-allowed' : 'pointer', backgroundColor: '#ecfdf5', color: '#065f46', opacity: depApproving ? 0.6 : 1 }}
              >
                {depApproving ? 'Approving…' : `Approve All (${draftDeps.length})`}
              </button>
            )}
          </div>
        )}

        {/* Properties grid */}
        <div style={{ marginBottom: '28px' }}>
          <h3 style={{ margin: '0 0 12px', fontSize: '14px', fontWeight: 600, color: 'var(--text-primary, #111827)' }}>Properties</h3>
          <div style={{ border: '1px solid var(--border-default, #e5e7eb)', borderRadius: '6px', padding: '4px 12px' }}>
            {config.properties.map(prop => {
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
              return <KVRow key={prop.field} label={prop.label} value={display} />;
            })}
          </div>
        </div>

        {/* Detail sections */}
        {(config.sections ?? []).map((section, idx) => {
          if (section.type === 'text') {
            const val = row[section.field];
            if (section.conditional && !val) return null;
            return (
              <div key={idx} style={{ marginBottom: '28px' }}>
                <SectionHeading title={section.title} />
                <p style={{ margin: 0, fontSize: '13px', color: 'var(--text-primary, #111827)', lineHeight: 1.6 }}>
                  {val ? String(val) : '—'}
                </p>
              </div>
            );
          }

          if (section.type === 'code') {
            const val = row[section.field];
            if (section.conditional && !val) return null;
            return (
              <div key={idx} style={{ marginBottom: '28px' }}>
                <SectionHeading title={section.title} />
                <pre style={{ margin: 0, padding: '12px 14px', backgroundColor: 'var(--surface-secondary, #f3f4f6)', borderRadius: '6px', fontSize: '12px', fontFamily: 'monospace', overflow: 'auto', border: '1px solid var(--border-default, #e5e7eb)', whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
                  {val ? String(val) : '—'}
                </pre>
              </div>
            );
          }

          if (section.type === 'dynamic_sql_table') {
            const val = row[section.field];
            return (
              <DynamicSqlSection
                key={idx}
                sql={val != null ? String(val) : null}
                title={section.title}
                limit={section.limit}
              />
            );
          }

          if (section.type === 'related_table') {
            return (
              <RelatedTableSection
                key={idx}
                section={section}
                showViewFn={showView}
              />
            );
          }

          return null;
        })}
      </div>
    </div>
  );
}

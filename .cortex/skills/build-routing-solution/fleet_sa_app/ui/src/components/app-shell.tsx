'use client';

import { useState, useRef, useCallback, useEffect } from 'react';
import { ChatPanel } from './chat/chat-panel';
import { ViewPanel } from './views/view-panel';
import { Header } from './header';
import { ContextBar, type ContextBarField } from './context-bar';
import { registerInlineComponents, registerToolMaps } from './inline';
import { registerViewsFromConfig, type ViewsConfig } from '@/lib/load-views';
import { registerWorkflowViews, registerRoleAccessView } from '@/lib/framework-views';
import { PACK_REGISTRY } from '@/lib/packs/registry';
import { useAppStore } from '@/lib/store';
import type { DisplayConfig } from '@/lib/types';
import { AboutDialog } from './about-dialog';

export interface AppConfig {
  name: string;
  description: string;
  targetUsers: string[];
  capabilities: string[];
  sampleQuestions: string[];
  snowflake?: { database: string; schema: string; warehouse?: string };
  hasWorkflows?: boolean;
  contextBar?: ContextBarField[];
  // Domain packs whose custom showcase views to register (4C loader). Each id
  // must exist in lib/packs/registry.ts. The legacy single `domainPack` string
  // is still honored and coerced to `[domainPack]`. A neutral app ships
  // `domainPacks: []` (pure-YAML dashboards, no domain code).
  domainPacks?: string[];
  domainPack?: string;
  // Neutral data-layer database the YAML views + surfacing gate bind to
  // (defaults to FLEET_APP for back-compat).
  dataLayer?: { database?: string };
  // Routing/tool config; mapTools render their output on the inline deck.gl map.
  tools?: { mapTools?: string[] };
  // Zero-code retargeting surface (labels/units/thresholds/statusEnums/icons/windows).
  display?: DisplayConfig;
}

const DEFAULT_APP_CONFIG: AppConfig = {
  name: 'Data App',
  description: '',
  targetUsers: [],
  capabilities: [],
  sampleQuestions: [],
};

registerInlineComponents();

const DEFAULT_RATIO = 0.5;
const MIN_RATIO = 0.15;
const MAX_RATIO = 0.88;
const COLLAPSE_CHAT_THRESHOLD = 0.08;
const COLLAPSE_PANEL_THRESHOLD = 0.92;

export function AppShell() {
  const [ratio, setRatio] = useState(DEFAULT_RATIO);
  const [panelCollapsed, setPanelCollapsed] = useState(false);
  const [chatCollapsed, setChatCollapsed] = useState(false);
  const [appConfig, setAppConfig] = useState<AppConfig | null>(null);
  const [contextBarFields, setContextBarFields] = useState<ContextBarField[]>([]);
  const [showAbout, setShowAbout] = useState(false);
  const [configError, setConfigError] = useState<string | null>(null);

  const containerRef = useRef<HTMLDivElement>(null);
  const dragging = useRef(false);
  const lastValidRatio = useRef(DEFAULT_RATIO);

  const setContext = useAppStore((s) => s.setContext);
  const bumpViewsVersion = useAppStore((s) => s.bumpViewsVersion);
  const setSnowflakeFqn = useAppStore((s) => s.setSnowflakeFqn);
  const setDetectedRole = useAppStore((s) => s.setDetectedRole);
  const setSelectedRole = useAppStore((s) => s.setSelectedRole);

  // Seed the role dropdown from the user's detected role (hint only; the
  // operator can still pick any role to evaluate). Failures are non-fatal.
  useEffect(() => {
    fetch('/api/whoami')
      .then((r) => r.json())
      .then((w: { detectedRole?: 'user' | 'ops' | 'admin' }) => {
        if (w.detectedRole) {
          setDetectedRole(w.detectedRole);
          setSelectedRole(w.detectedRole);
        }
      })
      .catch(() => {});
  }, [setDetectedRole, setSelectedRole]);

  useEffect(() => {
    Promise.all([
      fetch('/api/app-config').then((r) => r.json()),
      fetch('/api/views-config').then((r) => r.json()),
      fetch('/api/pack-status').then((r) => r.json()).catch(() => ({ schemas: {} })),
    ])
      .then(([appConfig, viewsConfig, packStatus]: [AppConfig, ViewsConfig, { schemas?: Record<string, boolean> }]) => {
        setAppConfig({ ...DEFAULT_APP_CONFIG, ...appConfig });

        // Surfacing gate: schemas whose pack data did not resolve are hidden.
        const schemaStatus = packStatus?.schemas ?? {};
        const disabledSchemas = new Set(
          Object.entries(schemaStatus).filter(([, present]) => !present).map(([s]) => s),
        );

        if (appConfig.contextBar) {
          setContextBarFields(appConfig.contextBar as ContextBarField[]);
          const today = new Date().toISOString().split('T')[0];
          for (const field of (appConfig.contextBar as ContextBarField[]) ) {
            if (field.type === 'enum' && field.default) {
              setContext(field.id, field.default);
              continue;
            }
            if (field.type === 'date_range' && field.default) {
              if (field.default === 'last_30_days') {
                const d = new Date();
                d.setDate(d.getDate() - 30);
                setContext(field.id, d.toISOString().split('T')[0]);
              } else if (field.default === 'last_365_days') {
                const d = new Date();
                d.setDate(d.getDate() - 365);
                setContext(field.id, d.toISOString().split('T')[0]);
              } else {
                setContext(field.id, field.default);
              }
              setContext('date_range_end', today);
            }
          }
        }

        if (Object.keys(viewsConfig).length > 0) {
          registerViewsFromConfig(viewsConfig, disabledSchemas, appConfig.dataLayer?.database);
        }
        // Bind this domain's map-producing tools to the inline map (config-driven).
        registerToolMaps(appConfig.tools?.mapTools ?? []);
        // Always-on role-evaluation view (works for any domain pack).
        registerRoleAccessView();
        // Config-driven domain-pack loader: register each configured pack's
        // custom showcase views via the registry — no domain import in the
        // shell. Legacy single `domainPack` string is coerced to an array.
        // Pack-backed showcases are gated by the surfacing set.
        const resolvedPacks =
          appConfig.domainPacks ?? (appConfig.domainPack ? [appConfig.domainPack] : []);
        for (const id of resolvedPacks) {
          PACK_REGISTRY[id]?.registerViews(disabledSchemas);
        }
        if (appConfig.snowflake?.database && appConfig.snowflake?.schema) {
          // Always set the FQN — it's used by the write layer and other framework features.
          setSnowflakeFqn(`${appConfig.snowflake.database}.${appConfig.snowflake.schema}`);
          if (appConfig.hasWorkflows !== false) {
            registerWorkflowViews(appConfig.snowflake.database, appConfig.snowflake.schema);
          }
        }
        bumpViewsVersion();
      })
      .catch((err) => {
        console.error('[AppShell] Failed to load config:', err);
        setConfigError('Failed to load app configuration');
      });
  }, [setContext, bumpViewsVersion, setSnowflakeFqn]);

  const handleMouseDown = useCallback(() => {
    dragging.current = true;
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
  }, []);

  const handleMouseMove = useCallback((e: MouseEvent) => {
    if (!dragging.current || !containerRef.current) return;
    const rect = containerRef.current.getBoundingClientRect();
    const rawRatio = (e.clientX - rect.left) / rect.width;

    if (rawRatio >= COLLAPSE_PANEL_THRESHOLD) {
      setPanelCollapsed(true);
      setChatCollapsed(false);
    } else if (rawRatio <= COLLAPSE_CHAT_THRESHOLD) {
      setChatCollapsed(true);
      setPanelCollapsed(false);
    } else {
      const clamped = Math.max(MIN_RATIO, Math.min(MAX_RATIO, rawRatio));
      setRatio(clamped);
      lastValidRatio.current = clamped;
      setPanelCollapsed(false);
      setChatCollapsed(false);
    }
  }, []);

  const handleMouseUp = useCallback(() => {
    if (!dragging.current) return;
    dragging.current = false;
    document.body.style.cursor = '';
    document.body.style.userSelect = '';
  }, []);

  const handleDoubleClick = useCallback(() => {
    setRatio(DEFAULT_RATIO);
    lastValidRatio.current = DEFAULT_RATIO;
    setPanelCollapsed(false);
    setChatCollapsed(false);
  }, []);

  const restorePanel = useCallback(() => {
    setPanelCollapsed(false);
    setChatCollapsed(false);
    setRatio(DEFAULT_RATIO);
  }, []);

  const restoreChat = useCallback(() => {
    setChatCollapsed(false);
    setPanelCollapsed(false);
    setRatio(DEFAULT_RATIO);
  }, []);

  useEffect(() => {
    window.addEventListener('mousemove', handleMouseMove);
    window.addEventListener('mouseup', handleMouseUp);
    return () => {
      window.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('mouseup', handleMouseUp);
    };
  }, [handleMouseMove, handleMouseUp]);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100vh', overflow: 'hidden' }}>
      <Header name={appConfig?.name || ''} onAboutClick={() => setShowAbout(true)} />
      {contextBarFields.length > 0 && <ContextBar fields={contextBarFields} />}
      {configError && (
        <div role="alert" style={{ padding: '8px 16px', backgroundColor: 'var(--surface-warning, #fffbeb)', color: 'var(--text-warning, #92400e)', fontSize: '13px', borderBottom: '1px solid var(--border-warning, #fde68a)' }}>
          {configError}
        </div>
      )}
      {showAbout && appConfig && <AboutDialog config={appConfig} onClose={() => setShowAbout(false)} />}
      <div ref={containerRef} style={{ display: 'flex', flex: 1, overflow: 'hidden', position: 'relative' }}>
        {!chatCollapsed ? (
          <div
            style={{
              width: panelCollapsed ? '100%' : `${ratio * 100}%`,
              overflow: 'hidden',
              display: 'flex',
              flexDirection: 'column',
            }}
          >
            <ChatPanel appConfig={appConfig || undefined} />
          </div>
        ) : (
          <button
            onClick={restoreChat}
            title="Show chat"
            style={{
              position: 'absolute',
              top: '50%',
              left: '0',
              transform: 'translateY(-50%)',
              zIndex: 50,
              width: '24px',
              height: '48px',
              padding: 0,
              borderRadius: '0 8px 8px 0',
              border: '1px solid var(--border-default, #e5e7eb)',
              borderLeft: 'none',
              backgroundColor: 'var(--surface-primary, #fff)',
              boxShadow: '2px 0 8px rgba(0,0,0,0.08)',
              cursor: 'pointer',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              color: 'var(--text-secondary, #6b7280)',
              fontSize: '14px',
            }}
          >
            ▶
          </button>
        )}
        {!panelCollapsed ? (
          <>
            <div
              onMouseDown={handleMouseDown}
              onDoubleClick={handleDoubleClick}
              style={{
                width: '6px',
                cursor: 'col-resize',
                backgroundColor: 'var(--border-default, #e5e7eb)',
                flexShrink: 0,
                transition: 'background-color 0.15s',
              }}
              onMouseEnter={(e) => {
                (e.currentTarget as HTMLDivElement).style.backgroundColor = 'var(--border-accent, #93b4f5)';
              }}
              onMouseLeave={(e) => {
                if (!dragging.current) {
                  (e.currentTarget as HTMLDivElement).style.backgroundColor = 'var(--border-default, #e5e7eb)';
                }
              }}
            />
            <div
              style={{
                flex: 1,
                overflow: 'hidden',
                display: 'flex',
                flexDirection: 'column',
                borderLeft: '1px solid var(--border-default, #e5e7eb)',
              }}
            >
              <ViewPanel />
            </div>
          </>
        ) : (
          <button
            onClick={restorePanel}
            title="Show panel"
            style={{
              position: 'absolute',
              top: '50%',
              right: '0',
              transform: 'translateY(-50%)',
              zIndex: 50,
              width: '24px',
              height: '48px',
              padding: 0,
              borderRadius: '8px 0 0 8px',
              border: '1px solid var(--border-default, #e5e7eb)',
              borderRight: 'none',
              backgroundColor: 'var(--surface-primary, #fff)',
              boxShadow: '-2px 0 8px rgba(0,0,0,0.08)',
              cursor: 'pointer',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              color: 'var(--text-secondary, #6b7280)',
              fontSize: '14px',
            }}
          >
            ◀
          </button>
        )}
      </div>
    </div>
  );
}

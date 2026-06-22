'use client';

import { useState, useEffect } from 'react';
import {
  MapPin, Wrench, Grid3X3, Database, Activity, LineChart, Stethoscope,
  SlidersHorizontal, ChevronDown, ChevronRight,
} from 'lucide-react';
import { useRegionProvider, RegionContext } from '@/hooks/useRegion';
import { useVehicleTypeProvider, VehicleTypeContext } from '@/hooks/useVehicleType';
import { DiagnosticsPage } from '@/components/pages/diagnostics';
import { ServiceManagerPage } from '@/components/pages/service-manager';
import { FunctionTesterPage } from '@/components/pages/function-tester';
import { MatrixViewerPage } from '@/components/pages/matrix-viewer';
import { RegionBuilderPage } from '@/components/pages/region-builder';
import { MatrixBuilderPage } from '@/components/pages/matrix-builder';
import { RoutingLimitsPage } from '@/components/pages/routing-limits';

interface SubPage { key: string; label: string; }
interface NavGroup {
  key: string;
  label: string;
  icon: React.ComponentType<{ size?: number; className?: string }>;
  subPages?: SubPage[];
}

// R5: this admin app holds ONLY the 9 privileged build/admin pages. The ~16 demo
// analytics pages migrate to the consumer app as packs (R6) and are NOT here.
const BUILD_TOOLS: NavGroup[] = [
  { key: 'regions', label: 'Region Builder', icon: MapPin },
  { key: 'functions', label: 'Directions & Isochrones', icon: Wrench },
  { key: 'matrix', label: 'Travel Matrix', icon: Grid3X3, subPages: [
    { key: 'matrix:builder', label: 'Builder' },
    { key: 'matrix:viewer', label: 'Viewer' },
  ]},
  { key: 'studio', label: 'Data Studio', icon: Database },
];

const OPERATIONS: NavGroup[] = [
  { key: 'services', label: 'Status & Health', icon: Activity },
  { key: 'observability', label: 'Observability', icon: LineChart },
  { key: 'diagnostics', label: 'Diagnostics', icon: Stethoscope },
  { key: 'routing-limits', label: 'Routing Limits', icon: SlidersHorizontal },
];

const ALL_SECTIONS = [
  { label: 'Build Tools', items: BUILD_TOOLS },
  { label: 'Operations', items: OPERATIONS },
];

const VALID_TABS: Set<string> = new Set(
  ALL_SECTIONS.flatMap((s) => s.items.flatMap((g) =>
    g.subPages ? [g.key, ...g.subPages.map((sp) => sp.key)] : [g.key],
  )),
);

function tabToPath(tab: string): string {
  if (!tab) return '/';
  return '/' + tab.replace(/:/g, '/');
}
function pathToTab(pathname: string): string {
  const trimmed = pathname.replace(/^\/+|\/+$/g, '');
  if (!trimmed) return 'services';
  const candidate = trimmed.replace(/\//g, ':');
  return VALID_TABS.has(candidate) ? candidate : 'services';
}
function headerLabel(tab: string): string {
  for (const section of ALL_SECTIONS) {
    for (const g of section.items) {
      if (tab === g.key) return g.label;
      if (g.subPages) {
        const sp = g.subPages.find((p) => p.key === tab);
        if (sp) return `${g.label} / ${sp.label}`;
      }
    }
  }
  return '';
}

function Placeholder({ tab }: { tab: string }) {
  return (
    <div className="panel">
      <h2>{headerLabel(tab)}</h2>
      <p className="subtitle">This privileged build tool is being ported to the new admin app (R5).</p>
      <div className="empty-state">Page <code>{tab}</code> — coming in this phase.</div>
    </div>
  );
}

// Tab -> page component. Pages are added as they are ported (tasks 3-9).
function renderPage(tab: string) {
  switch (tab) {
    case 'services': return <ServiceManagerPage />;
    case 'regions': return <RegionBuilderPage />;
    case 'functions': return <FunctionTesterPage />;
    case 'matrix:viewer': return <MatrixViewerPage />;
    case 'matrix:builder': return <MatrixBuilderPage />;
    case 'matrix': return <MatrixBuilderPage />;
    case 'routing-limits': return <RoutingLimitsPage />;
    case 'diagnostics': return <DiagnosticsPage />;
    default: return <Placeholder tab={tab} />;
  }
}

export function AppShell() {
  const [activeTab, setActiveTab] = useState<string>(() =>
    typeof window !== 'undefined' ? pathToTab(window.location.pathname) : 'services',
  );
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [appVersion, setAppVersion] = useState('');
  const region = useRegionProvider();
  const vehicleTypeCtx = useVehicleTypeProvider();

  useEffect(() => {
    fetch('/api/health').then((r) => r.json()).then((d) => setAppVersion(d.version || '')).catch(() => {});
  }, []);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const expected = tabToPath(activeTab);
    if (window.location.pathname !== expected) {
      window.history.replaceState({}, '', expected);
    }
    const onPop = () => setActiveTab(pathToTab(window.location.pathname));
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const navigateTo = (tab: string) => {
    setActiveTab(tab);
    if (typeof window !== 'undefined') {
      const next = tabToPath(tab);
      if (window.location.pathname !== next) window.history.pushState({ tab }, '', next);
    }
  };
  const toggleExpand = (k: string) => setExpanded((p) => ({ ...p, [k]: !p[k] }));

  const activeCategory = activeTab.includes(':') ? activeTab.split(':')[0] : activeTab;

  const renderNavGroup = (g: NavGroup) => {
    const isGroupActive = activeCategory === g.key;
    if (!g.subPages) {
      return (
        <button key={g.key} className={`sidebar-link${isGroupActive ? ' active' : ''}`} onClick={() => navigateTo(g.key)}>
          <g.icon size={16} />
          {g.label}
        </button>
      );
    }
    const isExpanded = expanded[g.key] ?? isGroupActive;
    return (
      <div key={g.key} className="sidebar-group">
        <button className={`sidebar-link sidebar-group-toggle${isGroupActive ? ' active' : ''}`} onClick={() => toggleExpand(g.key)}>
          <g.icon size={16} />
          {g.label}
          {isExpanded ? <ChevronDown size={14} className="chevron" /> : <ChevronRight size={14} className="chevron" />}
        </button>
        {isExpanded && (
          <div className="sidebar-sub-links">
            {g.subPages.map((sp) => (
              <button key={sp.key} className={`sidebar-sub-link${activeTab === sp.key ? ' active' : ''}`} onClick={() => navigateTo(sp.key)}>
                {sp.label}
              </button>
            ))}
          </div>
        )}
      </div>
    );
  };

  return (
    <RegionContext.Provider value={region.value}>
      <VehicleTypeContext.Provider value={vehicleTypeCtx.value}>
        <div className="app">
          <aside className="sidebar">
            <div className="sidebar-brand">
              <span>Routing Platform — Admin</span>
            </div>
            <nav className="sidebar-nav">
              {ALL_SECTIONS.map((section) => (
                <div key={section.label}>
                  <div className="sidebar-section">{section.label}</div>
                  {section.items.map(renderNavGroup)}
                </div>
              ))}
            </nav>
            <div className="sidebar-footer">
              <span className="sidebar-version">{appVersion ? `v${appVersion}` : ''}</span>
            </div>
          </aside>

          <div className="app-content">
            <header className="app-header">
              <span style={{ fontSize: 14, fontWeight: 500, color: 'var(--text)' }}>{headerLabel(activeTab)}</span>
            </header>
            <main className="app-main">{renderPage(activeTab)}</main>
          </div>
        </div>
      </VehicleTypeContext.Provider>
    </RegionContext.Provider>
  );
}

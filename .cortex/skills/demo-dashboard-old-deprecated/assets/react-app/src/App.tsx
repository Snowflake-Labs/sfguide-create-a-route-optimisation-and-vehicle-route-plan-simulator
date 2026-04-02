import { useMemo } from 'react';
import { Routes, Route } from 'react-router-dom';
import { useRegistry, useOrsStatus } from './registry/useRegistry';
import PageRegistry from './registry/PageRegistry';
import Sidebar from './layout/Sidebar';
import Header from './layout/Header';
import PageShell from './layout/PageShell';
import Home from './pages/home/Home';
import { useRegionProvider, RegionContext } from './hooks/useRegion';

export default function App() {
  const { demos, loading, error, refresh } = useRegistry();
  const orsStatus = useOrsStatus();
  const { value: regionValue } = useRegionProvider();

  const enrichedDemos = useMemo(() =>
    demos.map(d => ({
      ...d,
      config: {
        ...d.config,
        ors: d.requires_ors ? {
          region: orsStatus.region,
          profiles: orsStatus.profiles || [],
          bounds: orsStatus.bounds,
          availableRegions: orsStatus.availableRegions || [],
        } : undefined,
      },
    })),
  [demos, orsStatus]);

  return (
    <RegionContext.Provider value={regionValue}>
      <div className="app-layout">
        <Sidebar demos={enrichedDemos} loading={loading} />
        <div className="app-content">
          <Header orsStatus={orsStatus} demoCount={enrichedDemos.filter(d => d.installed).length} />
          <main className="app-main">
            <Routes>
              <Route path="/" element={<Home demos={enrichedDemos} loading={loading} error={error} onRefresh={refresh} orsStatus={orsStatus} />} />
              {enrichedDemos.filter(d => d.installed).map(demo =>
                demo.pages.map(page => (
                  <Route
                    key={page.id}
                    path={page.path}
                    element={
                      <PageShell demo={demo} orsStatus={orsStatus}>
                        <PageRegistry pageId={page.id} demo={demo} />
                      </PageShell>
                    }
                  />
                ))
              )}
              <Route path="*" element={<div className="page-not-found">Page not found</div>} />
            </Routes>
          </main>
        </div>
      </div>
    </RegionContext.Provider>
  );
}

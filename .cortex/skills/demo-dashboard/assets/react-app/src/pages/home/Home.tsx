import { useNavigate } from 'react-router-dom';
import { Box, RefreshCw, Truck, Clock, Store, CarTaxiFront, Utensils, GitBranch, Bot, Timer, Database } from 'lucide-react';
import type { DemoRegistration, OrsStatus } from '../../registry/types';

const ICON_MAP: Record<string, React.ComponentType<any>> = {
  truck: Truck, clock: Clock, store: Store, 'car-taxi': CarTaxiFront,
  utensils: Utensils, 'git-branch': GitBranch, bot: Bot,
  timer: Timer, database: Database, box: Box,
};

interface HomeProps {
  demos: DemoRegistration[];
  loading: boolean;
  error: string | null;
  onRefresh: () => void;
  orsStatus: OrsStatus;
}

export default function Home({ demos, loading, error, onRefresh, orsStatus }: HomeProps) {
  const navigate = useNavigate();
  const installedDemos = demos.filter(d => d.installed);
  const availableDemos = demos.filter(d => !d.installed);

  return (
    <div className="home-page">
      <div className="home-header">
        <div>
          <h1>Fleet Intelligence Demo Dashboard</h1>
          <p className="home-subtitle">
            {installedDemos.length === 0
              ? 'No demos installed yet. Run a demo skill to get started.'
              : `${installedDemos.length} demo${installedDemos.length !== 1 ? 's' : ''} installed`}
          </p>
        </div>
        <button className="btn-icon" onClick={onRefresh} title="Refresh registry">
          <RefreshCw size={18} className={loading ? 'spinning' : ''} />
        </button>
      </div>
      {error && <div className="home-error">Registry error: {error}</div>}
      <div className="home-status-bar">
        <div className={`status-chip ${orsStatus.installed ? 'ok' : 'warn'}`}>
          ORS Routing: {orsStatus.installed ? 'Available' : 'Not Installed'}
        </div>
        <div className="status-chip ok">Dashboard: Running</div>
      </div>
      {installedDemos.length === 0 && !loading ? (
        <div className="home-empty">
          <Box size={64} strokeWidth={1} />
          <h2>No Demos Installed</h2>
          <p>Install a demo skill to add pages to this dashboard. Each skill creates its data pipeline and registers here automatically.</p>
        </div>
      ) : (
        <div className="home-grid">
          {installedDemos.map(demo => {
            const Icon = ICON_MAP[demo.icon] || Box;
            const firstPage = demo.pages[0];
            return (
              <button
                key={demo.demo_id}
                className="home-card"
                onClick={() => navigate(firstPage.path)}
              >
                <div className="home-card-icon"><Icon size={32} /></div>
                <h3>{demo.display_name}</h3>
                <p>{demo.description}</p>
                <div className="home-card-meta">
                  <span>{demo.pages.length} page{demo.pages.length !== 1 ? 's' : ''}</span>
                  {demo.requires_ors && <span className="ors-badge">ORS</span>}
                  <span>v{demo.version}</span>
                </div>
              </button>
            );
          })}
        </div>
      )}
      {availableDemos.length > 0 && (
        <div className="home-available">
          <h3>Available Demo Skills</h3>
          <p className="home-available-hint">Deploy the required skill to enable these demos.</p>
          <div className="home-grid">
            {availableDemos.map(demo => {
              const Icon = ICON_MAP[demo.icon] || Box;
              return (
                <div key={demo.demo_id} className="home-card disabled">
                  <div className="home-card-icon"><Icon size={32} /></div>
                  <h3>{demo.display_name}</h3>
                  <p>{demo.description}</p>
                  <div className="home-card-meta">
                    <span>{demo.pages.length} page{demo.pages.length !== 1 ? 's' : ''}</span>
                    <span className="not-installed-badge">Not Installed</span>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

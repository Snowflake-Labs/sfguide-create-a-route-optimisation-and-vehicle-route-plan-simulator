import { NavLink, useLocation } from 'react-router-dom';
import { useState } from 'react';
import { Home, ChevronDown, ChevronRight, Truck, Clock, Store, CarTaxiFront, Utensils, GitBranch, Bot, Timer, Database, Box } from 'lucide-react';
import type { DemoRegistration } from '../registry/types';

const ICON_MAP: Record<string, React.ComponentType<any>> = {
  truck: Truck, clock: Clock, store: Store, 'car-taxi': CarTaxiFront,
  utensils: Utensils, 'git-branch': GitBranch, bot: Bot,
  timer: Timer, database: Database, box: Box,
};

interface SidebarProps {
  demos: DemoRegistration[];
  loading: boolean;
}

export default function Sidebar({ demos, loading }: SidebarProps) {
  const location = useLocation();
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});

  const toggleExpand = (demoId: string) => {
    setExpanded(prev => ({ ...prev, [demoId]: !prev[demoId] }));
  };

  return (
    <aside className="sidebar">
      <div className="sidebar-brand">
        <img src="/snowflake_h3.png" alt="Snowflake" style={{ height: 36, objectFit: 'contain' }} />
        <span className="sidebar-title">Demo Dashboard</span>
      </div>
      <nav className="sidebar-nav">
        <NavLink to="/" className={({ isActive }) => `sidebar-link ${isActive ? 'active' : ''}`}>
          <Home size={18} />
          <span>Home</span>
        </NavLink>
        {loading && <div className="sidebar-loading">Loading demos...</div>}
        {demos.filter(d => d.installed).map(demo => {
          const Icon = ICON_MAP[demo.icon] || Box;
          const topPages = demo.pages.filter(p => !p.parent);
          const hasSubPages = topPages.length > 1 || demo.pages.some(p => p.parent);
          const isActive = demo.pages.some(p => location.pathname === p.path);
          const isExpanded = expanded[demo.demo_id] ?? isActive;

          if (!hasSubPages) {
            const page = demo.pages[0];
            return (
              <NavLink key={demo.demo_id} to={page.path} className={({ isActive }) => `sidebar-link ${isActive ? 'active' : ''}`}>
                <Icon size={18} />
                <span>{demo.display_name}</span>
              </NavLink>
            );
          }

          return (
            <div key={demo.demo_id} className="sidebar-group">
              <button
                className={`sidebar-link sidebar-group-toggle ${isActive ? 'active' : ''}`}
                onClick={() => toggleExpand(demo.demo_id)}
              >
                <Icon size={18} />
                <span>{demo.display_name}</span>
                {isExpanded ? <ChevronDown size={14} className="chevron" /> : <ChevronRight size={14} className="chevron" />}
              </button>
              {isExpanded && (
                <div className="sidebar-sub-links">
                  {demo.pages.map(page => (
                    <NavLink key={page.id} to={page.path} className={({ isActive }) => `sidebar-sub-link ${isActive ? 'active' : ''}`}>
                      <span>{page.title}</span>
                    </NavLink>
                  ))}
                </div>
              )}
            </div>
          );
        })}
      </nav>
      <div className="sidebar-footer">
        <span>Powered by Snowflake</span>
      </div>
    </aside>
  );
}

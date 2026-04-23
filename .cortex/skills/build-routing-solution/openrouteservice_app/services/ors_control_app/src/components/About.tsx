import { useState, useEffect } from 'react';
import { Activity, Server, MapPin, Route, Truck, Database, Bot, Layers, ArrowRight, ExternalLink } from 'lucide-react';

interface ServiceStatus {
  name: string;
  status: string;
}

export default function About() {
  const [services, setServices] = useState<ServiceStatus[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch('/api/query', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        sql: `SELECT "name" AS NAME, "status" AS STATUS FROM TABLE(RESULT_SCAN(LAST_QUERY_ID())) ORDER BY NAME`,
        database: 'OPENROUTESERVICE_APP',
        schema: 'CORE',
      }),
    }).catch(() => {});

    fetch('/api/query', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        sql: `SHOW SERVICES IN DATABASE OPENROUTESERVICE_APP`,
        database: 'OPENROUTESERVICE_APP',
        schema: 'CORE',
      }),
    })
      .then(r => r.json())
      .then(data => {
        const rows = Array.isArray(data) ? data : data.result ?? [];
        setServices(rows.map((r: any) => ({ name: r.name || r.NAME, status: r.status || r.STATUS })));
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  const allRunning = services.length > 0 && services.every(s => s.status === 'RUNNING');

  return (
    <div style={{ maxWidth: 860, margin: '0 auto' }}>
      <div style={{ marginBottom: 32 }}>
        <h2 style={{ fontSize: 24, marginBottom: 8 }}>Routing & Fleet Intelligence on Snowflake</h2>
        <p style={{ color: 'var(--text-secondary)', fontSize: 14, lineHeight: 1.7, maxWidth: 700 }}>
          A turnkey geospatial routing platform that runs entirely inside your Snowflake account.
          It combines <strong>OpenRouteService</strong> on Snowpark Container Services with Snowflake's native
          geospatial functions to give you directions, isochrones, travel matrices, and vehicle route optimization,
          all accessible as SQL functions with no external APIs required.
        </p>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16, marginBottom: 32 }}>
        <div style={{ padding: 20, borderRadius: 12, border: '1px solid var(--border)', background: 'var(--surface)' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12 }}>
            <Server size={18} style={{ color: 'var(--accent)' }} />
            <h3 style={{ fontSize: 14, margin: 0 }}>What It Is</h3>
          </div>
          <ul style={{ fontSize: 13, color: 'var(--text-secondary)', lineHeight: 1.8, paddingLeft: 18 }}>
            <li>5 SPCS services: ORS engine, VROOM optimizer, gateway proxy, map downloader, this control app</li>
            <li>SQL functions for directions, isochrones, travel matrices, and route optimization</li>
            <li>Multi-region support: deploy routing for any geography</li>
            <li>Synthetic data generation for testing and demos</li>
          </ul>
        </div>
        <div style={{ padding: 20, borderRadius: 12, border: '1px solid var(--border)', background: 'var(--surface)' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12 }}>
            <Layers size={18} style={{ color: 'var(--accent)' }} />
            <h3 style={{ fontSize: 14, margin: 0 }}>How It's Intended To Be Used</h3>
          </div>
          <ul style={{ fontSize: 13, color: 'var(--text-secondary)', lineHeight: 1.8, paddingLeft: 18 }}>
            <li><strong>Deploy</strong> the routing services into your account</li>
            <li><strong>Use</strong> the core SQL functions directly in your pipelines and apps</li>
            <li><strong>Extend</strong> with Solution Accelerators as starting points for your use case</li>
            <li><strong>Customize</strong> regions, vehicle types, and routing profiles</li>
          </ul>
        </div>
      </div>

      <div style={{ marginBottom: 32 }}>
        <h3 style={{ fontSize: 11, color: 'var(--text-secondary)', textTransform: 'uppercase', letterSpacing: 0.8, marginBottom: 16 }}>Architecture</h3>
        <div style={{ padding: 24, borderRadius: 12, border: '1px solid var(--border)', background: 'var(--surface)' }}>
          <div style={{ display: 'flex', gap: 12, alignItems: 'stretch' }}>
            <ArchBlock icon={<Database size={16} />} title="Your SQL" subtitle="SELECT directions(...)" color="var(--accent)" />
            <Arrow />
            <ArchBlock icon={<Server size={16} />} title="Gateway Proxy" subtitle="SPCS reverse proxy" color="var(--text-secondary)" />
            <Arrow />
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8, flex: 1 }}>
              <ArchBlock icon={<MapPin size={16} />} title="ORS Engine" subtitle="Directions, isochrones, matrices" color="var(--green)" small />
              <ArchBlock icon={<Route size={16} />} title="VROOM Optimizer" subtitle="Vehicle route planning" color="var(--yellow)" small />
            </div>
          </div>
          <div style={{ display: 'flex', gap: 12, alignItems: 'stretch', marginTop: 12 }}>
            <ArchBlock icon={<Truck size={16} />} title="Control App" subtitle="This UI: manage and explore" color="var(--accent)" />
            <ArchBlock icon={<Activity size={16} />} title="Map Downloader" subtitle="Fetches OSM data for regions" color="var(--text-secondary)" />
            <ArchBlock icon={<Bot size={16} />} title="Cortex Agent" subtitle="Natural language routing" color="var(--text-secondary)" />
          </div>
          <p style={{ marginTop: 16, fontSize: 12, color: 'var(--text-secondary)', lineHeight: 1.6 }}>
            All services run on a shared SPCS compute pool. SQL functions call the gateway, which routes to ORS or VROOM.
            Results return as structured JSON you can parse in SQL. Travel matrices pre-compute H3-to-H3 travel times for fast lookups.
          </p>
        </div>
      </div>

      <div style={{ marginBottom: 32 }}>
        <h3 style={{ fontSize: 11, color: 'var(--text-secondary)', textTransform: 'uppercase', letterSpacing: 0.8, marginBottom: 16 }}>Getting Started Workflow</h3>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
          <Step n={1} title="Check Service Status" desc="Verify all 5 SPCS services are running in the Status page" />
          <Step n={2} title="Configure a Region" desc="Use Region Builder to set up your geography with map data and routing profiles" />
          <Step n={3} title="Test Core Functions" desc="Try Directions & Isochrones to verify routing works for your region" />
          <Step n={4} title="Build a Travel Matrix" desc="Pre-compute H3 travel times for fast analytical queries" />
          <Step n={5} title="Explore Solution Accelerators" desc="Use fleet, retail, or optimization examples as starting points for your application" />
        </div>
      </div>

      <div style={{ marginBottom: 32 }}>
        <h3 style={{ fontSize: 11, color: 'var(--text-secondary)', textTransform: 'uppercase', letterSpacing: 0.8, marginBottom: 16 }}>Service Health</h3>
        {loading ? (
          <p style={{ fontSize: 13, color: 'var(--text-secondary)' }}>Checking services...</p>
        ) : services.length === 0 ? (
          <p style={{ fontSize: 13, color: 'var(--text-secondary)' }}>Unable to check service status. Use the Status page for details.</p>
        ) : (
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            {services.map(s => (
              <div key={s.name} style={{
                padding: '8px 14px', borderRadius: 8, fontSize: 12, fontWeight: 500,
                border: `1px solid ${s.status === 'RUNNING' ? 'rgba(13,176,72,0.3)' : 'rgba(229,161,0,0.3)'}`,
                background: s.status === 'RUNNING' ? 'rgba(13,176,72,0.06)' : 'rgba(229,161,0,0.06)',
                color: s.status === 'RUNNING' ? 'var(--green)' : 'var(--yellow)',
              }}>
                {s.name.replace('OPENROUTESERVICE_APP.CORE.', '')}: {s.status}
              </div>
            ))}
          </div>
        )}
        {!loading && allRunning && (
          <p style={{ marginTop: 8, fontSize: 12, color: 'var(--green)' }}>All services operational.</p>
        )}
      </div>

      <div style={{ padding: 16, borderRadius: 10, background: 'rgba(41,181,232,0.06)', border: '1px solid rgba(41,181,232,0.15)', fontSize: 13, color: 'var(--text-secondary)', lineHeight: 1.7 }}>
        <strong style={{ color: 'var(--text)' }}>Key SQL Functions</strong>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '4px 24px', marginTop: 8, fontFamily: "'SF Mono', 'Fira Code', monospace", fontSize: 12 }}>
          <span><span style={{ color: 'var(--accent)' }}>ORS_DIRECTIONS</span>(profile, coords)</span>
          <span><span style={{ color: 'var(--accent)' }}>ORS_ISOCHRONES</span>(profile, center, ranges)</span>
          <span><span style={{ color: 'var(--accent)' }}>ORS_MATRIX</span>(profile, sources, targets)</span>
          <span><span style={{ color: 'var(--accent)' }}>ORS_OPTIMIZATION</span>(jobs, vehicles)</span>
        </div>
      </div>
    </div>
  );
}

function ArchBlock({ icon, title, subtitle, color, small }: { icon: React.ReactNode; title: string; subtitle: string; color: string; small?: boolean }) {
  return (
    <div style={{
      flex: 1, padding: small ? '10px 12px' : '14px 16px', borderRadius: 8,
      border: '1px solid var(--border)', background: 'var(--bg)',
      display: 'flex', flexDirection: 'column', gap: 4,
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, color }}>
        {icon}
        <span style={{ fontSize: small ? 12 : 13, fontWeight: 600, color: 'var(--text)' }}>{title}</span>
      </div>
      <span style={{ fontSize: 11, color: 'var(--text-secondary)' }}>{subtitle}</span>
    </div>
  );
}

function Arrow() {
  return (
    <div style={{ display: 'flex', alignItems: 'center', padding: '0 4px', color: 'var(--text-secondary)' }}>
      <ArrowRight size={16} />
    </div>
  );
}

function Step({ n, title, desc }: { n: number; title: string; desc: string }) {
  return (
    <div style={{
      display: 'flex', alignItems: 'flex-start', gap: 12, padding: '12px 16px',
      borderRadius: 8, border: '1px solid var(--border)', background: 'var(--surface)',
    }}>
      <div style={{
        width: 24, height: 24, borderRadius: '50%', background: 'var(--accent)',
        color: 'white', display: 'flex', alignItems: 'center', justifyContent: 'center',
        fontSize: 12, fontWeight: 600, flexShrink: 0,
      }}>{n}</div>
      <div>
        <div style={{ fontSize: 13, fontWeight: 600 }}>{title}</div>
        <div style={{ fontSize: 12, color: 'var(--text-secondary)' }}>{desc}</div>
      </div>
    </div>
  );
}

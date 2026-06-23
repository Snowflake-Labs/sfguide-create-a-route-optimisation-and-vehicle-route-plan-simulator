'use client';

import { useEffect, useMemo, useState } from 'react';
import type { ViewProps } from '@/lib/types';
import { useAppStore } from '@/lib/store';
import { viewRegistry } from '@/lib/view-registry';
import {
  APP_ROLES,
  ROLE_LABELS,
  ROLE_DESCRIPTIONS,
  ROLE_SNOWFLAKE_ROLE,
  type AppRole,
} from '@/lib/roles';

// Verb tiers accumulate with the role hierarchy: user < ops < admin.
const TIER_ORDER: AppRole[] = ['user', 'ops', 'admin'];
function tiersFor(role: AppRole): AppRole[] {
  const idx = TIER_ORDER.indexOf(role);
  return TIER_ORDER.slice(0, idx + 1);
}

interface AppConfigShape {
  tools?: { schema?: string; verbs?: Record<string, number> };
  ops?: { schema?: string; verbs?: Record<string, number> };
  admin?: { schema?: string; verbs?: Record<string, number> };
  roleAccess?: Partial<Record<AppRole, { schemas?: string[]; contract?: string[] }>>;
}

// Built-in fallbacks (used when app-config.json omits the block). These mirror
// routing_platform/setup.sql + role_binding.sql.
const FALLBACK_VERBS: Record<AppRole, Record<string, number>> = {
  user: {
    optimize_routes: 5,
    compute_isochrone: 3,
    get_directions: 2,
    find_poi: 5,
    pharma_catchment: 3,
    pharma_optimization: 1,
    supply_chain: 1,
  },
  ops: {
    set_active_region: 1,
    service_control: 2,
    service_status: 1,
    service_inventory: 0,
    healthcheck: 0,
  },
  admin: {
    set_active_region: 1,
    check_substrate: 0,
  },
};

const FALLBACK_ACCESS: Record<AppRole, { schemas: string[]; contract: string[] }> = {
  user: {
    schemas: ['FLEET_APP.* (read)'],
    contract: ['ROUTING_PLATFORM.CONTRACT.* (call: DIRECTIONS, ISOCHRONES, OPTIMIZATION, MATRIX, ROUTING_STATUS)'],
  },
  ops: {
    schemas: ['FLEET_APP.* (read)', 'FLEET_INTELLIGENCE.SYNAPSE_OPS (call)'],
    contract: ['ROUTING_PLATFORM.PROVIDERS (read)', 'ROUTING_PLATFORM.ADMIN.SET_REGION_PROVIDER (call)'],
  },
  admin: {
    schemas: ['FLEET_INTELLIGENCE.SYNAPSE_ADMIN (call)'],
    contract: ['ROUTING_PLATFORM.ADMIN.* (full CRUD: region to provider map)'],
  },
};

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div style={{ marginBottom: '20px' }}>
      <div
        style={{
          fontSize: '12px',
          fontWeight: 700,
          textTransform: 'uppercase',
          letterSpacing: '0.04em',
          color: 'var(--text-tertiary, #9ca3af)',
          marginBottom: '8px',
        }}
      >
        {title}
      </div>
      {children}
    </div>
  );
}

function Chip({ text, muted }: { text: string; muted?: boolean }) {
  return (
    <span
      style={{
        display: 'inline-block',
        fontSize: '12px',
        padding: '3px 8px',
        margin: '0 6px 6px 0',
        borderRadius: '6px',
        border: '1px solid var(--border-default, #e5e7eb)',
        backgroundColor: muted ? 'transparent' : 'var(--surface-secondary, #f9fafb)',
        color: muted ? 'var(--text-tertiary, #9ca3af)' : 'var(--text-primary, #111827)',
      }}
    >
      {text}
    </span>
  );
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function RoleAccessView(_props: ViewProps) {
  const selectedRole = useAppStore((s) => s.selectedRole);
  const detectedRole = useAppStore((s) => s.detectedRole);
  const setSelectedRole = useAppStore((s) => s.setSelectedRole);
  const viewsVersion = useAppStore((s) => s.viewsVersion);
  const [cfg, setCfg] = useState<AppConfigShape | null>(null);

  useEffect(() => {
    fetch('/api/app-config')
      .then((r) => r.json())
      .then((c: AppConfigShape) => setCfg(c))
      .catch(() => setCfg({}));
  }, []);

  const verbsByTier = useMemo<Record<AppRole, Record<string, number>>>(() => {
    return {
      user: cfg?.tools?.verbs ?? FALLBACK_VERBS.user,
      ops: cfg?.ops?.verbs ?? FALLBACK_VERBS.ops,
      admin: cfg?.admin?.verbs ?? FALLBACK_VERBS.admin,
    };
  }, [cfg]);

  const accessByTier = useMemo(() => {
    const ra = cfg?.roleAccess ?? {};
    const merge = (role: AppRole) => ({
      schemas: ra[role]?.schemas ?? FALLBACK_ACCESS[role].schemas,
      contract: ra[role]?.contract ?? FALLBACK_ACCESS[role].contract,
    });
    return { user: merge('user'), ops: merge('ops'), admin: merge('admin') };
  }, [cfg]);

  const tiers = tiersFor(selectedRole);

  const visibleViews = useMemo(
    () => viewRegistry.list(selectedRole),
    [selectedRole, viewsVersion],
  );

  const verbRows = tiers.flatMap((tier) =>
    Object.entries(verbsByTier[tier]).map(([verb, args]) => ({ verb, args, tier })),
  );

  const schemas = tiers.flatMap((t) => accessByTier[t].schemas);
  const contract = tiers.flatMap((t) => accessByTier[t].contract);

  return (
    <div style={{ padding: '20px', overflow: 'auto', height: '100%' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: '10px', marginBottom: '6px' }}>
        <h2 style={{ fontSize: '18px', fontWeight: 700, margin: 0, color: 'var(--text-primary, #111827)' }}>
          Role Access — {ROLE_LABELS[selectedRole]}
        </h2>
        <span style={{ fontSize: '12px', color: 'var(--text-tertiary, #9ca3af)' }}>
          ({ROLE_SNOWFLAKE_ROLE[selectedRole]})
        </span>
      </div>
      <p style={{ fontSize: '13px', color: 'var(--text-secondary, #6b7280)', marginTop: 0, marginBottom: '8px' }}>
        {ROLE_DESCRIPTIONS[selectedRole]}
      </p>

      <div style={{ display: 'flex', gap: '6px', marginBottom: '4px' }}>
        {APP_ROLES.map((r) => (
          <button
            key={r}
            onClick={() => setSelectedRole(r)}
            style={{
              fontSize: '12px',
              fontWeight: 600,
              padding: '5px 12px',
              borderRadius: '8px',
              cursor: 'pointer',
              border: '1px solid var(--border-default, #e5e7eb)',
              backgroundColor: r === selectedRole ? 'var(--surface-accent, #e0edff)' : 'var(--surface-primary, #fff)',
              color: 'var(--text-primary, #111827)',
            }}
          >
            {ROLE_LABELS[r]}
          </button>
        ))}
      </div>
      <p style={{ fontSize: '11px', color: 'var(--text-tertiary, #9ca3af)', marginTop: '6px', marginBottom: '18px' }}>
        Simulated view filter — switching role changes what this UI surfaces, not the privileges used for backend calls.
        {detectedRole ? ` Your detected role is ${ROLE_LABELS[detectedRole]}.` : ''}
      </p>

      <Section title={`Visible views (${visibleViews.length})`}>
        <div>
          {visibleViews.map((v) => (
            <Chip key={v.id} text={v.label} />
          ))}
        </div>
      </Section>

      <Section title={`Tools / verbs (${verbRows.length})`}>
        <div>
          {verbRows.map(({ verb, args, tier }) => (
            <Chip key={`${tier}:${verb}`} text={`${verb} (${args} arg${args === 1 ? '' : 's'})`} muted={tier !== selectedRole} />
          ))}
          {verbRows.length === 0 && <Chip text="None" muted />}
        </div>
      </Section>

      <Section title="Data / schema access">
        <div>
          {schemas.map((s, i) => (
            <Chip key={`s${i}`} text={s} />
          ))}
        </div>
      </Section>

      <Section title="Routing contract access">
        <div>
          {contract.map((c, i) => (
            <Chip key={`c${i}`} text={c} />
          ))}
        </div>
      </Section>
    </div>
  );
}

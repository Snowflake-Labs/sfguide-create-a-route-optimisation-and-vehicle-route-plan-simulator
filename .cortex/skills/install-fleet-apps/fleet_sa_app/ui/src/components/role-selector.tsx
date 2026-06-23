'use client';

import { useAppStore } from '@/lib/store';
import { APP_ROLES, ROLE_LABELS, ROLE_DESCRIPTIONS, type AppRole } from '@/lib/roles';

// Role-evaluation selector. Picking a role filters which views the UI surfaces
// and what the Role Access view summarizes. This is a SIMULATED filter for
// evaluation — it does not change the privileges used for backend calls.
export function RoleSelector() {
  const selectedRole = useAppStore((s) => s.selectedRole);
  const detectedRole = useAppStore((s) => s.detectedRole);
  const setSelectedRole = useAppStore((s) => s.setSelectedRole);

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
      <span
        style={{
          fontSize: '11px',
          fontWeight: 500,
          color: 'var(--text-tertiary, #9ca3af)',
        }}
      >
        Role
      </span>
      <select
        aria-label="Evaluate as role"
        title={ROLE_DESCRIPTIONS[selectedRole]}
        value={selectedRole}
        onChange={(e) => setSelectedRole(e.target.value as AppRole)}
        style={{
          fontSize: '12px',
          fontWeight: 600,
          padding: '4px 8px',
          borderRadius: '8px',
          border: '1px solid var(--border-default, #e5e7eb)',
          backgroundColor: 'var(--surface-primary, #fff)',
          color: 'var(--text-primary, #111827)',
          cursor: 'pointer',
        }}
      >
        {APP_ROLES.map((r) => (
          <option key={r} value={r}>
            {ROLE_LABELS[r]}
            {detectedRole === r ? ' (you)' : ''}
          </option>
        ))}
      </select>
    </div>
  );
}

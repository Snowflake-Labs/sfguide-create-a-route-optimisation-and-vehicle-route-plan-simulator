'use client';
import { MapPin, Route } from 'lucide-react';
import { useActivePreset } from '@/hooks/useActivePreset';

export interface RoutingOption {
  value: string;
  label: string;
}

interface Props {
  region: string;
  profile: string;
  onChange: (next: { region: string; profile: string }) => void;
  regions?: RoutingOption[];
  profiles?: RoutingOption[];
  showResetToPreset?: boolean;
  compact?: boolean;
}

const DEFAULT_PROFILES: RoutingOption[] = [
  { value: 'driving-car', label: 'Car' },
  { value: 'cycling-electric', label: 'E-Bike' },
  { value: 'driving-hgv', label: 'HGV Truck' },
  { value: 'cycling-road', label: 'Road Bike' },
];

export default function PresetRoutingControls({
  region,
  profile,
  onChange,
  regions,
  profiles = DEFAULT_PROFILES,
  showResetToPreset = true,
  compact = false,
}: Props) {
  const preset = useActivePreset();
  const diverged = region !== preset.region || profile !== preset.orsProfile;

  return (
    <div
      className="preset-routing-controls"
      style={{
        display: 'flex',
        flexWrap: 'wrap',
        alignItems: 'center',
        gap: compact ? 6 : 10,
        fontSize: compact ? 12 : 13,
      }}
    >
      <label style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
        <MapPin size={compact ? 12 : 14} />
        <select
          className="select"
          value={region}
          onChange={(e) => onChange({ region: e.target.value, profile })}
          style={{ minWidth: compact ? 120 : 140, width: 'auto' }}
        >
          {(regions ?? [{ value: preset.region, label: preset.regionDisplay }]).map((r) => (
            <option key={r.value} value={r.value}>{r.label}</option>
          ))}
        </select>
      </label>
      <label style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
        <Route size={compact ? 12 : 14} />
        <select
          className="select"
          value={profile}
          onChange={(e) => onChange({ region, profile: e.target.value })}
          style={{ minWidth: compact ? 110 : 130, width: 'auto' }}
        >
          {profiles.map((p) => (
            <option key={p.value} value={p.value}>{p.label}</option>
          ))}
        </select>
      </label>
      {showResetToPreset && diverged && (
        <button
          type="button"
          className="btn btn-sm btn-secondary"
          style={{ fontSize: 11, padding: '2px 8px' }}
          onClick={() => onChange({ region: preset.region, profile: preset.orsProfile })}
        >
          Match preset
        </button>
      )}
    </div>
  );
}

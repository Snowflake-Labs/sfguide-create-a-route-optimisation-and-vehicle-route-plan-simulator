// Panel 1: profile templates list + saved presets selector. Pure
// presentational component; selection dispatches to parent callbacks.

import { Truck } from 'lucide-react';
import { Preset, ProfileTemplate, SKILL_MAP, VEHICLE_COLORS, VEHICLE_ICONS } from '../helpers';

interface Props {
  templates: ProfileTemplate[];
  presets: Preset[];
  selectedTemplate: ProfileTemplate | null;
  selectedPreset: Preset | null;
  skillsReady: Record<string, boolean>;
  onSelectTemplate: (t: ProfileTemplate) => void;
  onSelectPreset: (p: Preset) => void;
}

export default function ProfilePickerPanel({
  templates, presets, selectedTemplate, selectedPreset, skillsReady,
  onSelectTemplate, onSelectPreset,
}: Props) {
  return (
    <div className="chart-card" style={{ padding: 16 }}>
      <h3 style={{ fontSize: 14, marginBottom: 12 }}>Profile Templates</h3>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        {templates.map((t) => {
          const Icon = VEHICLE_ICONS[t.vehicleType] || Truck;
          const color = VEHICLE_COLORS[t.vehicleType] || '#6E7681';
          const isSelected = selectedTemplate?.id === t.id;
          return (
            <div
              key={t.id}
              onClick={() => onSelectTemplate(t)}
              style={{
                padding: 12, borderRadius: 8, cursor: 'pointer',
                border: isSelected ? `2px solid ${color}` : '1px solid #E1E4E8',
                background: isSelected ? `${color}08` : '#FAFBFC',
                transition: 'all 0.15s ease',
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
                <Icon size={18} color={color} />
                <span style={{ fontSize: 13, fontWeight: 600, color: '#24292F' }}>{t.name}</span>
              </div>
              <div style={{ fontSize: 11, color: '#6E7681', marginBottom: 6 }}>{t.description}</div>
              <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
                <span style={{ fontSize: 10, padding: '1px 6px', borderRadius: 10, background: `${color}18`, color, fontWeight: 500 }}>
                  {t.vehicleType}
                </span>
                <span style={{ fontSize: 10, padding: '1px 6px', borderRadius: 10, background: '#F0F0F0', color: '#6E7681' }}>
                  {t.regionScale}
                </span>
                {t.feeds.map((f) => (
                  <span
                    key={f}
                    style={{
                      fontSize: 10, padding: '1px 6px', borderRadius: 10,
                      background: skillsReady[f] ? '#E6F9ED' : '#FFF8E6',
                      color: skillsReady[f] ? '#1B7A3D' : '#9D6B00',
                    }}
                  >
                    {SKILL_MAP[f] || f}
                  </span>
                ))}
              </div>
            </div>
          );
        })}
      </div>

      {presets.length > 0 && (
        <>
          <h4 style={{ fontSize: 12, marginTop: 16, marginBottom: 8, color: '#6E7681' }}>Saved Presets</h4>
          {presets.filter((p) => !p.is_builtin).map((p) => (
            <div
              key={p.preset_id}
              onClick={() => onSelectPreset(p)}
              style={{
                padding: '8px 10px', marginBottom: 4, borderRadius: 6, cursor: 'pointer', fontSize: 12,
                border: selectedPreset?.preset_id === p.preset_id ? '2px solid #29B5E8' : '1px solid #E1E4E8',
                background: selectedPreset?.preset_id === p.preset_id ? '#F0F9FF' : '#FAFBFC',
              }}
            >
              <div style={{ fontWeight: 500 }}>{p.name}</div>
              <div style={{ fontSize: 10, color: '#6E7681' }}>{p.region} | {p.ors_profile}</div>
            </div>
          ))}
        </>
      )}
    </div>
  );
}

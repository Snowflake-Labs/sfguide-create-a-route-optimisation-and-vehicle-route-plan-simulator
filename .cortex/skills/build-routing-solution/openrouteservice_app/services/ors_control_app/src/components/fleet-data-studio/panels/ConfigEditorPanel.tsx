// Panel 2: configuration editor with collapsible sections. Renders preset
// fields, region/profile selectors, and Generate / Stop / Save actions.

import React from 'react';
import { Bike, ChevronDown, ChevronRight, Clock, Database, Play, Save, Square, Truck } from 'lucide-react';
import { Preset, ProfileTemplate, VEHICLE_COLORS, VEHICLE_ICONS, VEHICLE_LABELS } from '../helpers';
import type { EditConfig } from '../types';

void Bike; // (suppress unused import warning if tree-shaken away later)

interface Props {
  editConfig: EditConfig;
  editName: string;
  editRegion: string;
  editProfile: string;
  availableRegions: { key: string; label: string }[];
  expandedSections: Set<string>;
  toggleSection: (s: string) => void;
  updateConfig: (path: string, value: any) => void;
  setEditName: (v: string) => void;
  setEditRegion: (v: string) => void;
  setEditProfile: (v: string) => void;
  selectedTemplate: ProfileTemplate | null;
  selectedPreset: Preset | null;
  generating: boolean;
  onStart: () => void;
  onCancelActive: () => void;
  onSave: () => void;
}

export default function ConfigEditorPanel(props: Props) {
  const {
    editConfig, editName, editRegion, editProfile, availableRegions,
    expandedSections, toggleSection, updateConfig,
    setEditName, setEditRegion, setEditProfile,
    selectedTemplate, selectedPreset, generating,
    onStart, onCancelActive, onSave,
  } = props;

  const renderField = (label: string, path: string, type: string = 'number') => {
    if (!editConfig) return null;
    const keys = path.split('.');
    let val: any = editConfig;
    for (const k of keys) { val = val?.[k]; }
    return (
      <div style={{ marginBottom: 8 }}>
        <label style={{ fontSize: 11, color: '#6E7681', display: 'block', marginBottom: 2 }}>{label}</label>
        <input
          type={type}
          value={val ?? ''}
          onChange={(e) => updateConfig(path, type === 'number' ? Number(e.target.value) : e.target.value)}
          style={{ width: '100%', padding: '4px 8px', borderRadius: 6, border: '1px solid #E1E4E8', fontSize: 13, background: '#FAFBFC' }}
        />
      </div>
    );
  };

  const renderSection = (key: string, title: string, content: React.ReactNode) => {
    const open = expandedSections.has(key);
    return (
      <div style={{ marginBottom: 4 }}>
        <div
          onClick={() => toggleSection(key)}
          style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '8px 0', cursor: 'pointer', borderBottom: '1px solid #E1E4E8', fontSize: 13, fontWeight: 600, color: '#24292F' }}
        >
          {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
          {title}
        </div>
        {open && <div style={{ padding: '8px 0' }}>{content}</div>}
      </div>
    );
  };

  const activeVehicleType = selectedTemplate?.vehicleType
    || (editProfile === 'cycling-electric' ? 'ebike' : editProfile === 'driving-hgv' ? 'hgv' : 'car');

  return (
    <div className="chart-card" style={{ padding: 16 }}>
      {!editConfig ? (
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', height: '100%', color: '#9CA3AF' }}>
          <Database size={40} strokeWidth={1.2} />
          <p style={{ fontSize: 14, marginTop: 12 }}>Select a profile to configure</p>
        </div>
      ) : (
        <>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
            <h3 style={{ fontSize: 14, margin: 0 }}>Configuration</h3>
            {(() => {
              const Icon = VEHICLE_ICONS[activeVehicleType] || Truck;
              const color = VEHICLE_COLORS[activeVehicleType] || '#6E7681';
              return <span style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 11, color, fontWeight: 600 }}><Icon size={14} />{VEHICLE_LABELS[activeVehicleType]}</span>;
            })()}
          </div>

          <div style={{ marginBottom: 12 }}>
            <label style={{ fontSize: 11, color: '#6E7681' }}>Preset Name</label>
            <input value={editName} onChange={(e) => setEditName(e.target.value)} style={{ width: '100%', padding: '4px 8px', borderRadius: 6, border: '1px solid #E1E4E8', fontSize: 13 }} />
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, marginBottom: 12 }}>
            <div>
              <label style={{ fontSize: 11, color: '#6E7681' }}>Region</label>
              <select value={editRegion} onChange={(e) => setEditRegion(e.target.value)} style={{ width: '100%', padding: '4px 8px', borderRadius: 6, border: '1px solid #E1E4E8', fontSize: 13 }}>
                {availableRegions.map((r) => (
                  <option key={r.key} value={r.key}>{r.label}</option>
                ))}
              </select>
            </div>
            <div>
              <label style={{ fontSize: 11, color: '#6E7681' }}>ORS Profile</label>
              <select value={editProfile} onChange={(e) => setEditProfile(e.target.value)} style={{ width: '100%', padding: '4px 8px', borderRadius: 6, border: '1px solid #E1E4E8', fontSize: 13 }}>
                <option value="driving-car">driving-car</option>
                <option value="cycling-electric">cycling-electric</option>
                <option value="driving-hgv">driving-hgv</option>
              </select>
            </div>
          </div>

          {renderSection('time', 'Time Range', (
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
              {renderField('Start Date', 'time.start_date', 'date')}
              {renderField('End Date', 'time.end_date', 'date')}
            </div>
          ))}

          {renderSection('fleet', 'Fleet', (
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
              {renderField('Vehicles', 'fleet.num_vehicles')}
              {renderField('Trips/Day Min', 'fleet.trips_per_day.min')}
              {renderField('Trips/Day Max', 'fleet.trips_per_day.max')}
              {renderField('Weekday Op Rate', 'fleet.weekday_operating_rate')}
            </div>
          ))}

          {renderSection('distance', 'Distance Distribution', (
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
              {renderField('Short %', 'distance_distribution.short_pct')}
              {renderField('Short Max km', 'distance_distribution.short_max_km')}
              {renderField('Medium %', 'distance_distribution.medium_pct')}
              {renderField('Medium Max km', 'distance_distribution.medium_max_km')}
            </div>
          ))}

          {renderSection('dwell', 'Dwell Times', (
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 8 }}>
              {renderField('Origin Median (min)', 'dwell.origin.median_min')}
              {renderField('Origin Sigma', 'dwell.origin.sigma')}
              {renderField('Origin Max (min)', 'dwell.origin.max_min')}
              {renderField('Dest Median (min)', 'dwell.destination.median_min')}
              {renderField('Dest Sigma', 'dwell.destination.sigma')}
              {renderField('Dest Max (min)', 'dwell.destination.max_min')}
            </div>
          ))}

          {renderSection('ghost', 'Long Idle Vehicles', (
            <div>
              <div style={{ fontSize: 11, color: '#6E7681', marginBottom: 8, lineHeight: 1.5 }}>
                Marks a share of vehicles as long-idle (parked at home for several days). Useful for ghost-trailer / off-rotation / dead-battery scenarios. Set Probability to 0 to disable.
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 8 }}>
                {renderField('Probability (0-1)', 'ghost_trailer.probability')}
                {renderField('Start Day Min', 'ghost_trailer.start_day_min')}
                {renderField('Start Day Max', 'ghost_trailer.start_day_max')}
                {renderField('Duration Days Min', 'ghost_trailer.duration_days_min')}
                {renderField('Duration Days Max', 'ghost_trailer.duration_days_max')}
                <div />
                {renderField('Ping Min (sec)', 'ghost_trailer.ping_interval_min_sec')}
                {renderField('Ping Max (sec)', 'ghost_trailer.ping_interval_max_sec')}
              </div>
            </div>
          ))}

          {renderSection('routing', 'Routing & Detours', (
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
              {renderField('Optimal Route %', 'routing.optimal_route_probability')}
              {renderField('Alt Route %', 'routing.alternative_route_probability')}
              {renderField('Detour Probability', 'detour.probability')}
              {renderField('Max Detour Factor', 'detour.max_detour_factor')}
              {renderField('Default Speed', 'routing.posted_speeds.default')}
            </div>
          ))}

          {renderSection('telemetry', 'Telemetry', (
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
              {renderField('Ping Mean (sec)', 'telemetry.ping_interval_moving.mean_sec')}
              {renderField('Ping Std (sec)', 'telemetry.ping_interval_moving.std_sec')}
              {renderField('GPS Jitter (m)', 'telemetry.gps_jitter.typical_m')}
              {renderField('Multipath Prob', 'telemetry.gps_jitter.multipath_probability')}
            </div>
          ))}

          {activeVehicleType === 'hgv' && renderSection('breaks', 'HOS / Breaks', (
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
              {renderField('Hours Between Breaks', 'breaks.driving_hours_between_breaks')}
              {renderField('Break Duration (min)', 'breaks.mandatory_break_duration_min')}
              {renderField('Max Daily Driving (h)', 'breaks.max_daily_driving_hours')}
            </div>
          ))}

          {activeVehicleType === 'ebike' && renderSection('battery', 'Battery', (
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
              {renderField('Range (km)', 'battery.range_km')}
              {renderField('Drain/km (%)', 'battery.drain_per_km')}
              {renderField('Recharge Threshold (%)', 'battery.recharge_threshold_pct')}
            </div>
          ))}

          {activeVehicleType === 'ebike' && renderSection('sla', 'Delivery SLA', (
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
              {renderField('Target (min)', 'delivery_sla.target_minutes')}
              {renderField('Warning (min)', 'delivery_sla.warning_minutes')}
            </div>
          ))}

          <div style={{ display: 'flex', gap: 8, marginTop: 16 }}>
            <button onClick={onStart} disabled={generating} className="btn-primary" style={{ flex: 1, fontSize: 13, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6 }}>
              {generating ? <><Clock size={14} className="spin" /> Generating...</> : <><Play size={14} /> Generate</>}
            </button>
            {generating && (
              <button onClick={onCancelActive} className="btn-secondary" style={{ fontSize: 12, display: 'flex', alignItems: 'center', gap: 4 }}>
                <Square size={12} /> Stop
              </button>
            )}
            {!selectedPreset?.is_builtin && (
              <button onClick={onSave} className="btn-secondary" style={{ fontSize: 12, display: 'flex', alignItems: 'center', gap: 4 }}>
                <Save size={12} /> Save
              </button>
            )}
          </div>
        </>
      )}
    </div>
  );
}

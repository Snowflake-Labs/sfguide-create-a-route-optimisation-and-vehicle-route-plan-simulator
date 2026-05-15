import { ChevronDown, Database, MapPin, Truck } from 'lucide-react';
import { useState, useRef, useEffect, useCallback } from 'react';
import { useRegion } from '../hooks/useRegion';
import { useVehicleType } from '../hooks/useVehicleType';

interface Dataset {
  jobId: string;
  presetName: string;
  region: string;
  regionDisplay: string;
  orsProfile: string;
  vehicleType: string;
  tripCount: number;
  pointCount: number;
  completedAt: string;
  isActive: boolean;
}

const PROFILE_LABELS: Record<string, string> = {
  'cycling-electric': 'E-Bike',
  'driving-hgv': 'HGV Truck',
  'driving-car': 'Car',
  'cycling-road': 'Road Bike',
};

export default function DatasetPicker() {
  const { switchRegion } = useRegion();
  const { switchVehicleType } = useVehicleType();
  const [datasets, setDatasets] = useState<Dataset[]>([]);
  const [activeLabel, setActiveLabel] = useState('Loading...');
  const [open, setOpen] = useState(false);
  const [switching, setSwitching] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  const fetchDatasets = useCallback(async () => {
    try {
      const res = await fetch('/api/datasets');
      if (res.ok) {
        const data = await res.json();
        setDatasets(data.datasets || []);
        const active = (data.datasets || []).find((d: Dataset) => d.isActive);
        if (active) setActiveLabel(active.presetName);
        else if (data.datasets?.length) setActiveLabel(data.datasets[0].presetName);
        else setActiveLabel('No datasets');
      }
    } catch {
      setActiveLabel('No datasets');
    }
  }, []);

  useEffect(() => { fetchDatasets(); }, [fetchDatasets]);

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, []);

  const handlePick = async (ds: Dataset) => {
    setOpen(false);
    setSwitching(true);
    try {
      await switchVehicleType(ds.vehicleType);
      await switchRegion(ds.region);
      setActiveLabel(ds.presetName);
      await fetchDatasets();
    } finally {
      setSwitching(false);
    }
  };

  const fmtCount = (n: number) => n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);

  return (
    <div className="region-switcher" ref={ref}>
      <button className={`region-trigger ${switching ? 'pulsing' : ''}`} onClick={() => setOpen(!open)}>
        <Database size={14} />
        <span>{activeLabel}{switching ? '...' : ''}</span>
        <ChevronDown size={12} className={open ? 'rotated' : ''} />
      </button>
      {open && (
        <div className="region-dropdown" style={{ minWidth: 280 }}>
          {datasets.length === 0 && (
            <div style={{ padding: '12px 10px', fontSize: 12, color: 'var(--text-secondary)' }}>
              No completed datasets. Generate one in Data Studio.
            </div>
          )}
          {datasets.map((ds) => (
            <button
              key={ds.jobId}
              className={`region-option ${ds.isActive ? 'active' : ''}`}
              onClick={() => handlePick(ds)}
              style={{ flexDirection: 'column', alignItems: 'flex-start', gap: 2 }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: 6, width: '100%' }}>
                <Database size={12} />
                <span style={{ fontWeight: 500, flex: 1 }}>{ds.presetName}</span>
                {ds.isActive && <span className="region-tag seed">Active</span>}
              </div>
              <div style={{ display: 'flex', gap: 8, fontSize: 11, color: 'var(--text-secondary)', paddingLeft: 18 }}>
                <span style={{ display: 'flex', alignItems: 'center', gap: 3 }}>
                  <MapPin size={10} />{ds.regionDisplay}
                </span>
                <span style={{ display: 'flex', alignItems: 'center', gap: 3 }}>
                  <Truck size={10} />{PROFILE_LABELS[ds.orsProfile] || ds.orsProfile}
                </span>
                <span>{fmtCount(ds.tripCount)} trips</span>
              </div>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

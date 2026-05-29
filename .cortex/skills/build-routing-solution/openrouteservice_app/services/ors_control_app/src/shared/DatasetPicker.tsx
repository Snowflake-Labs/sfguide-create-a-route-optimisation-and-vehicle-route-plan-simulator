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
  fleetRowCount?: number;
  isAvailable?: boolean;
}

const PROFILE_LABELS: Record<string, string> = {
  'cycling-electric': 'E-Bike',
  'driving-hgv': 'HGV Truck',
  'driving-car': 'Car',
  'cycling-road': 'Road Bike',
};

export default function DatasetPicker() {
  const region = useRegion();
  const vehicleTypeCtx = useVehicleType();
  const [datasets, setDatasets] = useState<Dataset[]>([]);
  const [currentRegion, setCurrentRegion] = useState<string | null>(null);
  const [currentVehicleType, setCurrentVehicleType] = useState<string | null>(null);
  const [activeLabel, setActiveLabel] = useState('Loading...');
  const [open, setOpen] = useState(false);
  const [switching, setSwitching] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const ref = useRef<HTMLDivElement>(null);

  const isSelected = useCallback((ds: Dataset, region: string | null, vehicleType: string | null) => {
    return region != null && vehicleType != null
      && ds.region === region && ds.vehicleType === vehicleType;
  }, []);

  const fetchDatasets = useCallback(async () => {
    try {
      const res = await fetch('/api/datasets');
      if (res.ok) {
        const data = await res.json();
        const list: Dataset[] = data.datasets || [];
        const region = data.currentRegion ?? null;
        const vehicleType = data.currentVehicleType ?? null;
        setDatasets(list);
        setCurrentRegion(region);
        setCurrentVehicleType(vehicleType);
        const selected = list.find((d) => isSelected(d, region, vehicleType));
        if (selected) setActiveLabel(selected.presetName);
        else if (list.length) setActiveLabel(list[0].presetName);
        else setActiveLabel('No datasets');
      }
    } catch {
      setActiveLabel('No datasets');
    }
  }, [isSelected]);

  useEffect(() => { fetchDatasets(); }, [fetchDatasets]);

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, []);

  const handlePick = async (ds: Dataset) => {
    if (isSelected(ds, currentRegion, currentVehicleType)) {
      setOpen(false);
      return;
    }
    if (ds.isAvailable === false) {
      setError('No fleet data for this preset — re-run Data Studio.');
      setOpen(false);
      return;
    }
    setOpen(false);
    setSwitching(true);
    setError(null);
    try {
      const res = await fetch('/api/datasets/activate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jobId: ds.jobId }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({ error: 'Unknown error' }));
        const msg = body.code === 'BOOT_INCOMPLETE'
          ? 'Service still booting — try again in a few seconds'
          : (body.error || `Activation failed (${res.status})`);
        setError(msg);
        await fetchDatasets();
        return;
      }
      await Promise.all([
        vehicleTypeCtx.refresh(),
        region.refresh(),
      ]);
      setActiveLabel(ds.presetName);
      window.dispatchEvent(new CustomEvent('ors-region-switched'));
      await fetchDatasets();
    } catch {
      setError('Network error — please retry');
    } finally {
      setSwitching(false);
    }
  };

  const fmtCount = (n: number) => n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);

  return (
    <div className="region-switcher" ref={ref}>
      <button
        type="button"
        className={`region-trigger ${switching ? 'pulsing' : ''}`}
        disabled={switching}
        onClick={() => { setError(null); setOpen(!open); }}
      >
        <Database size={14} />
        <span>{activeLabel}{switching ? '...' : ''}</span>
        <ChevronDown size={12} className={open ? 'rotated' : ''} />
      </button>
      {error && (
        <div
          className="region-tag"
          style={{
            marginTop: 4,
            fontSize: 11,
            color: 'var(--danger, #E5484D)',
            maxWidth: 280,
            lineHeight: 1.3,
          }}
          role="alert"
        >
          {error}
        </div>
      )}
      {open && (
        <div className="region-dropdown" style={{ minWidth: 280 }}>
          {datasets.length === 0 && (
            <div style={{ padding: '12px 10px', fontSize: 12, color: 'var(--text-secondary)' }}>
              No completed datasets. Generate one in Data Studio.
            </div>
          )}
          {datasets.map((ds) => {
            const unavailable = ds.isAvailable === false;
            const selected = isSelected(ds, currentRegion, currentVehicleType);
            return (
              <button
                key={ds.jobId}
                type="button"
                className={`region-option ${selected ? 'active' : ''}`}
                onClick={() => handlePick(ds)}
                style={{
                  flexDirection: 'column',
                  alignItems: 'flex-start',
                  gap: 2,
                  opacity: unavailable ? 0.55 : 1,
                  cursor: unavailable ? 'not-allowed' : 'pointer',
                }}
              >
                <div style={{ display: 'flex', alignItems: 'center', gap: 6, width: '100%' }}>
                  <Database size={12} />
                  <span style={{ fontWeight: 500, flex: 1 }}>{ds.presetName}</span>
                  {selected && <span className="region-tag seed">Active</span>}
                  {unavailable && (
                    <span className="region-tag" style={{ fontSize: 10, opacity: 0.9 }}>
                      no fleet data
                    </span>
                  )}
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
            );
          })}
        </div>
      )}
    </div>
  );
}

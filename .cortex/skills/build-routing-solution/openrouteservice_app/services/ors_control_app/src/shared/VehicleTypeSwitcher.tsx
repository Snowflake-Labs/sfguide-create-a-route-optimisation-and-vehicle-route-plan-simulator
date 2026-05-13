import { ChevronDown, Truck } from 'lucide-react';
import { useState, useRef, useEffect, useMemo } from 'react';
import { useVehicleType } from '../hooks/useVehicleType';
import { useRegion } from '../hooks/useRegion';

const TYPE_LABELS: Record<string, string> = {
  hgv: 'Truck (HGV)',
  car: 'Car / Taxi',
  ebike: 'E-Bike',
  escooter: 'E-Scooter',
};

export default function VehicleTypeSwitcher() {
  const { vehicleType, availableTypes, switchVehicleType, typesForRegion, datasetPairs } = useVehicleType();
  const { regionName } = useRegion();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, []);

  const filteredTypes = useMemo(() => {
    if (!datasetPairs.length) return availableTypes;
    const valid = new Set(typesForRegion(regionName));
    const filtered = availableTypes.filter(t => valid.has(t));
    return filtered.length ? filtered : availableTypes;
  }, [availableTypes, regionName, datasetPairs, typesForRegion]);

  return (
    <div className="region-switcher" ref={ref}>
      <button className="region-trigger" onClick={() => setOpen(!open)}>
        <Truck size={14} />
        <span>{TYPE_LABELS[vehicleType] || vehicleType}</span>
        <ChevronDown size={12} className={open ? 'rotated' : ''} />
      </button>
      {open && (
        <div className="region-dropdown">
          {filteredTypes.map((t: string) => (
            <button
              key={t}
              className={`region-option ${t === vehicleType ? 'active' : ''}`}
              onClick={() => {
                switchVehicleType(t);
                setOpen(false);
              }}
            >
              <Truck size={12} />
              <span>{TYPE_LABELS[t] || t}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

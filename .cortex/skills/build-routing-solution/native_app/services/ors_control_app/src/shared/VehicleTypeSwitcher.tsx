import { ChevronDown, Truck } from 'lucide-react';
import { useState, useRef, useEffect } from 'react';
import { useVehicleType } from '../hooks/useVehicleType';

const TYPE_LABELS: Record<string, string> = {
  hgv: 'Truck (HGV)',
  car: 'Car / Taxi',
  ebike: 'E-Bike',
  escooter: 'E-Scooter',
};

export default function VehicleTypeSwitcher() {
  const { vehicleType, availableTypes, switchVehicleType } = useVehicleType();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, []);

  if (availableTypes.length <= 1) {
    return (
      <div className="region-badge">
        <Truck size={14} />
        <span>{TYPE_LABELS[vehicleType] || vehicleType}</span>
      </div>
    );
  }

  return (
    <div className="region-switcher" ref={ref}>
      <button className="region-trigger" onClick={() => setOpen(!open)}>
        <Truck size={14} />
        <span>{TYPE_LABELS[vehicleType] || vehicleType}</span>
        <ChevronDown size={12} className={open ? 'rotated' : ''} />
      </button>
      {open && (
        <div className="region-dropdown">
          {availableTypes.map((t: string) => (
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

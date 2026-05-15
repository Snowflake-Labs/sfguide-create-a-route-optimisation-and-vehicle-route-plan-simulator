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
  const { vehicleType, availableTypes, switchVehicleType, regionsForType, typesForRegion, datasetPairs } = useVehicleType();
  const { regionName, switchRegion } = useRegion();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, []);

  // Set of vehicle types that have data for the CURRENT region (used only
  // for visual styling - we no longer hard-filter the dropdown).
  const validTypes = useMemo(() => {
    if (!datasetPairs.length) return new Set<string>();
    return new Set(typesForRegion(regionName));
  }, [regionName, datasetPairs, typesForRegion]);

  // Auto-correcting click handler: if the picked vehicle type has no data
  // for the current region, atomically switch the region to the first valid
  // one for that vehicle type. Breaks the cross-filter deadlock.
  const handleTypeClick = async (target: string) => {
    setOpen(false);
    const validRegionsForTarget = regionsForType(target);
    if (validRegionsForTarget.length > 0 && !validRegionsForTarget.includes(regionName)) {
      await switchRegion(validRegionsForTarget[0]);
    }
    await switchVehicleType(target);
  };

  return (
    <div className="region-switcher" ref={ref}>
      <button className="region-trigger" onClick={() => setOpen(!open)}>
        <Truck size={14} />
        <span>{TYPE_LABELS[vehicleType] || vehicleType}</span>
        <ChevronDown size={12} className={open ? 'rotated' : ''} />
      </button>
      {open && (
        <div className="region-dropdown">
          {availableTypes.map((t: string) => {
            const hasDataForCurrentRegion = !validTypes.size || validTypes.has(t);
            const validRegionsForT = regionsForType(t);
            const willAutoSwitchTo = !hasDataForCurrentRegion && validRegionsForT.length > 0
              ? validRegionsForT[0]
              : null;
            const titleHint = willAutoSwitchTo
              ? `Switches region to ${willAutoSwitchTo}`
              : undefined;
            return (
              <button
                key={t}
                className={`region-option ${t === vehicleType ? 'active' : ''} ${!hasDataForCurrentRegion ? 'region-option--no-data' : ''}`}
                onClick={() => handleTypeClick(t)}
                title={titleHint}
              >
                <Truck size={12} />
                <span>{TYPE_LABELS[t] || t}</span>
                {willAutoSwitchTo && (
                  <span className="region-tag autoswitch">{willAutoSwitchTo}</span>
                )}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

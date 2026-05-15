import { ChevronDown, MapPin, Globe } from 'lucide-react';
import { useState, useRef, useEffect, useMemo } from 'react';
import { useRegion, type RegionInfo } from '../hooks/useRegion';
import { useVehicleType } from '../hooks/useVehicleType';

const TYPE_LABELS: Record<string, string> = {
  hgv: 'HGV',
  car: 'Car',
  ebike: 'E-Bike',
  escooter: 'E-Scooter',
};

export default function RegionSwitcher() {
  const { regionName, displayName, regions, switchRegion } = useRegion();
  const { vehicleType, switchVehicleType, regionsForType, typesForRegion, datasetPairs } = useVehicleType();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, []);

  // Set of regions that have data for the CURRENT vehicleType (used only for
  // visual styling / tooltip - we no longer hard-filter the dropdown).
  const validRegions = useMemo(() => {
    if (!datasetPairs.length) return new Set<string>();
    return new Set(regionsForType(vehicleType));
  }, [vehicleType, datasetPairs, regionsForType]);

  // Auto-correcting click handler: if the picked region has no data for the
  // current vehicleType, atomically switch the vehicleType to the first
  // valid one for that region. This breaks the cross-filter deadlock where
  // (ebike, SF) is the only valid pair but the user wants (hgv, Germany).
  const handleRegionClick = async (target: string) => {
    setOpen(false);
    const validTypes = typesForRegion(target);
    if (validTypes.length > 0 && !validTypes.includes(vehicleType)) {
      await switchVehicleType(validTypes[0]);
    }
    await switchRegion(target);
  };

  return (
    <div className="region-switcher" ref={ref}>
      <button className="region-trigger" onClick={() => setOpen(!open)}>
        <Globe size={14} />
        <span>{displayName}</span>
        <ChevronDown size={12} className={open ? 'rotated' : ''} />
      </button>
      {open && (
        <div className="region-dropdown">
          {regions.map((r: RegionInfo) => {
            const hasDataForCurrentType = !validRegions.size || validRegions.has(r.REGION_NAME);
            const validTypes = typesForRegion(r.REGION_NAME);
            const willAutoSwitchTo = !hasDataForCurrentType && validTypes.length > 0
              ? validTypes[0]
              : null;
            const titleHint = willAutoSwitchTo
              ? `Switches vehicle type to ${TYPE_LABELS[willAutoSwitchTo] || willAutoSwitchTo}`
              : undefined;
            return (
              <button
                key={r.REGION_NAME}
                className={`region-option ${r.REGION_NAME === regionName ? 'active' : ''} ${!hasDataForCurrentType ? 'region-option--no-data' : ''}`}
                onClick={() => handleRegionClick(r.REGION_NAME)}
                title={titleHint}
              >
                <MapPin size={12} />
                <span>{r.DISPLAY_NAME}</span>
                {willAutoSwitchTo && (
                  <span className="region-tag autoswitch">{TYPE_LABELS[willAutoSwitchTo] || willAutoSwitchTo}</span>
                )}
                {r.DATA_SOURCE === 'S3_BASELINE' && (
                  <span className="region-tag seed">Baseline</span>
                )}
                {r.DATA_SOURCE === 'SYNTHETIC' && (
                  <span className="region-tag synthetic">Generated</span>
                )}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

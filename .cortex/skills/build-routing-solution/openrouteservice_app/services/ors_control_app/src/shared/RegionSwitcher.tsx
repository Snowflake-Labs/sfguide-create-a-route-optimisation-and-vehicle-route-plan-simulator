import { ChevronDown, MapPin, Globe } from 'lucide-react';
import { useState, useRef, useEffect, useMemo } from 'react';
import { useRegion, type RegionInfo } from '../hooks/useRegion';
import { useVehicleType } from '../hooks/useVehicleType';

export default function RegionSwitcher() {
  const { regionName, displayName, regions, switchRegion } = useRegion();
  const { vehicleType, regionsForType, datasetPairs } = useVehicleType();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, []);

  const validRegions = useMemo(() => {
    if (!datasetPairs.length) return new Set<string>();
    return new Set(regionsForType(vehicleType));
  }, [vehicleType, datasetPairs, regionsForType]);

  const filteredRegions = useMemo(() => {
    if (!validRegions.size) return regions;
    return regions.filter(r => validRegions.has(r.REGION_NAME));
  }, [regions, validRegions]);

  return (
    <div className="region-switcher" ref={ref}>
      <button className="region-trigger" onClick={() => setOpen(!open)}>
        <Globe size={14} />
        <span>{displayName}</span>
        <ChevronDown size={12} className={open ? 'rotated' : ''} />
      </button>
      {open && (
        <div className="region-dropdown">
          {filteredRegions.map((r: RegionInfo) => (
            <button
              key={r.REGION_NAME}
              className={`region-option ${r.REGION_NAME === regionName ? 'active' : ''}`}
              onClick={() => {
                switchRegion(r.REGION_NAME);
                setOpen(false);
              }}
            >
              <MapPin size={12} />
              <span>{r.DISPLAY_NAME}</span>
              {r.DATA_SOURCE === 'S3_BASELINE' && (
                <span className="region-tag seed">Baseline</span>
              )}
              {r.DATA_SOURCE === 'SYNTHETIC' && (
                <span className="region-tag synthetic">Generated</span>
              )}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

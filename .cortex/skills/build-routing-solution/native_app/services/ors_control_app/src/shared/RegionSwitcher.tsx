import { ChevronDown, MapPin, Globe } from 'lucide-react';
import { useState, useRef, useEffect } from 'react';
import { useRegion, type RegionInfo } from '../hooks/useRegion';

export default function RegionSwitcher() {
  const { regionName, displayName, regions, switchRegion } = useRegion();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, []);

  return (
    <div className="region-switcher" ref={ref}>
      <button className="region-trigger" onClick={() => setOpen(!open)}>
        <Globe size={14} />
        <span>{displayName}</span>
        <ChevronDown size={12} className={open ? 'rotated' : ''} />
      </button>
      {open && (
        <div className="region-dropdown">
          {regions.map((r: RegionInfo) => (
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

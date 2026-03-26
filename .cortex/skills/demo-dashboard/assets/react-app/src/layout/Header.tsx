import { Circle } from 'lucide-react';
import type { OrsStatus } from '../registry/types';
import RegionSwitcher from '../shared/RegionSwitcher';

interface HeaderProps {
  orsStatus: OrsStatus;
  demoCount: number;
}

export default function Header({ orsStatus, demoCount }: HeaderProps) {
  return (
    <header className="app-header">
      <div className="header-left">
        <span className="header-demos-count">{demoCount} demo{demoCount !== 1 ? 's' : ''} installed</span>
      </div>
      <div className="header-right">
        <RegionSwitcher />
        <div className={`ors-status-badge ${orsStatus.installed ? 'available' : 'unavailable'}`}>
          <Circle size={8} fill={orsStatus.installed ? '#0DB048' : '#E5484D'} strokeWidth={0} />
          <span>ORS {orsStatus.installed ? 'Available' : 'Not Installed'}</span>
        </div>
      </div>
    </header>
  );
}

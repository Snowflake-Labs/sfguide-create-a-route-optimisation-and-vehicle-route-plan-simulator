import { useEffect, useState } from 'react';
import DwellOverview from './dwell/DwellOverview';
import FacilityUtilization from './dwell/FacilityUtilization';
import SLAAlerts from './dwell/SLAAlerts';
import DriverPerformance from './dwell/DriverPerformance';
import CongestionMap from './dwell/CongestionMap';
import TripInspector from './dwell/TripInspector';
import LiveOperations from './dwell/LiveOperations';

type SubTab = 'overview' | 'facilities' | 'sla' | 'drivers' | 'congestion' | 'trips' | 'live';

const VALID: SubTab[] = ['overview', 'facilities', 'sla', 'drivers', 'congestion', 'trips', 'live'];

interface Props { subTab?: string; }

export default function DwellAnalysis({ subTab }: Props) {
  const [activeTab, setActiveTab] = useState<SubTab>((subTab as SubTab) || 'overview');

  useEffect(() => {
    if (subTab && VALID.includes(subTab as SubTab)) {
      setActiveTab(subTab as SubTab);
    }
  }, [subTab]);

  return (
    <>
      {activeTab === 'overview' && <DwellOverview />}
      {activeTab === 'facilities' && <FacilityUtilization />}
      {activeTab === 'sla' && <SLAAlerts />}
      {activeTab === 'drivers' && <DriverPerformance />}
      {activeTab === 'congestion' && <CongestionMap />}
      {activeTab === 'trips' && <TripInspector />}
      {activeTab === 'live' && <LiveOperations />}
    </>
  );
}

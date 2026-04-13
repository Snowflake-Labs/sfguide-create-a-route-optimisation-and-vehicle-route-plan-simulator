import { useEffect, useState } from 'react';
import FleetOverview from './fleet-taxis/FleetOverview';
import DriverRoutes from './fleet-taxis/DriverRoutes';
import HeatMap from './fleet-taxis/HeatMap';

type SubTab = 'overview' | 'routes' | 'heatmap';

const VALID: SubTab[] = ['overview', 'routes', 'heatmap'];

interface Props { subTab?: string; }

export default function FleetTaxis({ subTab }: Props) {
  const [activeTab, setActiveTab] = useState<SubTab>((subTab as SubTab) || 'overview');

  useEffect(() => {
    if (subTab && VALID.includes(subTab as SubTab)) {
      setActiveTab(subTab as SubTab);
    }
  }, [subTab]);

  return (
    <>
      {activeTab === 'overview' && <FleetOverview />}
      {activeTab === 'routes' && <DriverRoutes />}
      {activeTab === 'heatmap' && <HeatMap />}
    </>
  );
}

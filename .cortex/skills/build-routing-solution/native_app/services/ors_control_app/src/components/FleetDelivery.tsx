import { useEffect, useState } from 'react';
import FleetMap from './fleet-delivery/FleetMap';
import CatchmentPanel from './fleet-delivery/CatchmentPanel';
import CourierHeatmap from './fleet-delivery/CourierHeatmap';
import DeliveryDashboard from './fleet-delivery/DeliveryDashboard';

type SubTab = 'map' | 'catchment' | 'heatmap' | 'dashboard';

const VALID: SubTab[] = ['map', 'catchment', 'heatmap', 'dashboard'];

interface Props { subTab?: string; }

export default function FleetDelivery({ subTab }: Props) {
  const [activeTab, setActiveTab] = useState<SubTab>((subTab as SubTab) || 'map');

  useEffect(() => {
    if (subTab && VALID.includes(subTab as SubTab)) {
      setActiveTab(subTab as SubTab);
    }
  }, [subTab]);

  return (
    <>
      {activeTab === 'map' && <FleetMap />}
      {activeTab === 'catchment' && <CatchmentPanel />}
      {activeTab === 'heatmap' && <CourierHeatmap />}
      {activeTab === 'dashboard' && <DeliveryDashboard />}
    </>
  );
}

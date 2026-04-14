import { useEffect, useState } from 'react';
import DeviationDashboard from './route-deviation/DeviationDashboard';
import RouteComparison from './route-deviation/RouteComparison';
import RouteInspector from './route-deviation/RouteInspector';

type SubTab = 'dashboard' | 'comparison' | 'inspector';

const VALID: SubTab[] = ['dashboard', 'comparison', 'inspector'];

interface Props { subTab?: string; }

export default function RouteDeviation({ subTab }: Props) {
  const [activeTab, setActiveTab] = useState<SubTab>((subTab as SubTab) || 'dashboard');

  useEffect(() => {
    if (subTab && VALID.includes(subTab as SubTab)) {
      setActiveTab(subTab as SubTab);
    }
  }, [subTab]);

  return (
    <>
      {activeTab === 'dashboard' && <DeviationDashboard />}
      {activeTab === 'comparison' && <RouteComparison />}
      {activeTab === 'inspector' && <RouteInspector />}
    </>
  );
}

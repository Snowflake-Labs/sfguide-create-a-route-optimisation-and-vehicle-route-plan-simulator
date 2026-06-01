// Driven entirely by URL via the `subTab` prop. The 5 sub-pages are exposed
// in the App sidebar; this shell just routes to the right component and
// hoists `selectedAlertId` so picking an alert in Hazard Ops persists across
// Triage, Reachability, and Dispatch.

import { useState, useEffect } from 'react';
import HazardOpsPage from './HazardOpsPage';
import TriagePage from './TriagePage';
import ReachabilityPage from './ReachabilityPage';
import DispatchPage from './DispatchPage';
import VulnerabilityPage from './VulnerabilityPage';

type Props = { subTab?: string };

const SELECTED_ALERT_LS_KEY = 'emergency.selectedAlertId';

export default function EmergencyResponseShell({ subTab }: Props) {
  const tab = subTab || 'hazard-ops';

  // Persist selectedAlertId in localStorage so it survives sub-tab navigation.
  const [selectedAlertId, setSelectedAlertIdRaw] = useState<string | undefined>(() => {
    if (typeof window === 'undefined') return undefined;
    return window.localStorage.getItem(SELECTED_ALERT_LS_KEY) || undefined;
  });

  const setSelectedAlertId = (id: string | undefined) => {
    setSelectedAlertIdRaw(id);
    if (typeof window !== 'undefined') {
      if (id) window.localStorage.setItem(SELECTED_ALERT_LS_KEY, id);
      else window.localStorage.removeItem(SELECTED_ALERT_LS_KEY);
    }
  };

  // If the user navigates straight to Triage/Reachability/Dispatch without
  // first selecting an alert and there are alerts present, auto-select the
  // first severe one. (Implemented inside HazardOpsPage's first fetch.)
  useEffect(() => {}, [tab]);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      {selectedAlertId && (
        <div
          style={{
            padding: '6px 12px',
            borderBottom: '1px solid var(--border, #ddd)',
            fontSize: 12,
            color: 'var(--text-secondary, #666)',
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
          }}
        >
          <span>
            Selected alert:&nbsp;<code>{selectedAlertId}</code>
          </span>
          <button
            onClick={() => setSelectedAlertId(undefined)}
            style={{
              fontSize: 11,
              background: 'transparent',
              border: '1px solid var(--border, #ddd)',
              borderRadius: 4,
              padding: '2px 8px',
              cursor: 'pointer',
            }}
          >
            Clear
          </button>
        </div>
      )}

      <div style={{ flex: 1, overflow: 'auto' }}>
        {tab === 'hazard-ops' && (
          <HazardOpsPage
            selectedAlertId={selectedAlertId}
            onSelectAlert={setSelectedAlertId}
          />
        )}
        {tab === 'triage'        && <TriagePage selectedAlertId={selectedAlertId} />}
        {tab === 'reachability'  && <ReachabilityPage selectedAlertId={selectedAlertId} />}
        {tab === 'dispatch'      && <DispatchPage selectedAlertId={selectedAlertId} />}
        {tab === 'vulnerability' && <VulnerabilityPage />}
      </div>
    </div>
  );
}

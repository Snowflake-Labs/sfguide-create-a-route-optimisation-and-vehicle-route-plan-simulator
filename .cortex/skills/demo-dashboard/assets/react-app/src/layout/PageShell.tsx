import type { ReactNode } from 'react';
import { AlertTriangle } from 'lucide-react';
import type { DemoRegistration, OrsStatus } from '../registry/types';

interface PageShellProps {
  demo: DemoRegistration;
  orsStatus: OrsStatus;
  children: ReactNode;
}

export default function PageShell({ demo, orsStatus, children }: PageShellProps) {
  if (demo.requires_ors && !orsStatus.installed) {
    return (
      <div className="page-shell-error">
        <AlertTriangle size={48} />
        <h2>ORS Routing Service Required</h2>
        <p>
          <strong>{demo.display_name}</strong> requires the OpenRouteService routing engine.
          Run the <code>build-routing-solution</code> skill to deploy it.
        </p>
      </div>
    );
  }

  return <div className="page-shell">{children}</div>;
}

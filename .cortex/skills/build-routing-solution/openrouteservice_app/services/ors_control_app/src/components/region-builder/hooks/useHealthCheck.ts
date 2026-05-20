// Loads /api/regions/healthcheck once on mount. Surfaces a HealthStatus or
// null if the call hasn't returned yet (callers render a banner only when
// `overall !== 'ok'`).

import { useEffect, useState } from 'react';
import type { HealthStatus } from '../types';

export function useHealthCheck() {
  const [health, setHealth] = useState<HealthStatus | null>(null);
  useEffect(() => {
    let cancelled = false;
    fetch('/api/regions/healthcheck')
      .then((r) => r.json())
      .then((d: HealthStatus) => { if (!cancelled) setHealth(d); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, []);
  return health;
}

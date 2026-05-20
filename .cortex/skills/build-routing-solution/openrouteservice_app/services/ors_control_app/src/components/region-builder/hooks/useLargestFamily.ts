// Loads /api/regions/largest-family once on mount. Falls back to the
// published default if the back-end is missing the proc.

import { useEffect, useState } from 'react';

export function useLargestFamily(initial = 'MEM_X64_G2_192') {
  const [family, setFamily] = useState<string>(initial);
  useEffect(() => {
    let cancelled = false;
    fetch('/api/regions/largest-family')
      .then((r) => r.json())
      .then((d) => { if (!cancelled && d && d.family) setFamily(d.family); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, []);
  return family;
}

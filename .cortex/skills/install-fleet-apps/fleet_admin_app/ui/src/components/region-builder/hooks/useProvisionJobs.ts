'use client';
// Provisioning jobs: list + polling while any job is RUNNING/PENDING.
// Splits jobs into active vs finished so callers can render them in
// separate sections.

import { useCallback, useEffect, useMemo, useState } from 'react';
import { ProvisionJob } from '../helpers';
import { useVisiblePolling } from '@/hooks/useVisiblePolling';

// A region build runs for minutes to HOURS, so a fast cadence buys no
// responsiveness on a 2-row status table - it just keeps the interactive
// warehouse awake. Measured on a real account: this loop plus useBuildProgress
// were the reason FLEET_APPS_WH never reached its 60s idle during a build, and
// warehouse credits are billed for hours-the-warehouse-is-up, not work done.
// 10s matches the cadence region-builder.tsx already adopted, for this reason.
const JOB_POLL_MS = 10000;

export function useProvisionJobs() {
  const [jobs, setJobs] = useState<ProvisionJob[]>([]);

  const fetchProvisionJobs = useCallback(async () => {
    try {
      const r = await fetch('/api/regions/provision/status');
      const data = await r.json();
      setJobs(data.jobs || []);
    } catch {}
  }, []);

  const cancelJob = useCallback(async (region: string) => {
    try {
      await fetch(`/api/regions/${encodeURIComponent(region)}/cancel`, { method: 'POST' });
      fetchProvisionJobs();
    } catch {}
  }, [fetchProvisionJobs]);

  const dismissJob = useCallback(async (jobId: string) => {
    setJobs((prev) => prev.filter((j) => j.job_id !== jobId));
    try {
      await fetch(`/api/regions/provision/${encodeURIComponent(jobId)}/dismiss`, { method: 'POST' });
    } catch {}
  }, []);

  useEffect(() => { fetchProvisionJobs(); }, [fetchProvisionJobs]);

  const activeJobs = useMemo(
    () => jobs.filter((j) => j.status === 'RUNNING' || j.status === 'PENDING'),
    [jobs],
  );
  const finishedJobs = useMemo(
    () => jobs.filter((j) => j.status !== 'RUNNING' && j.status !== 'PENDING'),
    [jobs],
  );
  const failedJobs = useMemo(
    () => finishedJobs.filter((j) => j.status === 'ERROR' || j.status === 'CANCELLED').slice(0, 10),
    [finishedJobs],
  );
  const completedJobs = useMemo(
    () => finishedJobs.filter((j) => j.status !== 'ERROR' && j.status !== 'CANCELLED').slice(0, 10),
    [finishedJobs],
  );

  const hasActiveJobs = activeJobs.length > 0;

  // Poll while anything is in flight, PAUSED whenever the tab is hidden. The
  // raw setInterval this replaces kept hitting GET_PROVISION_STATUS for the
  // whole duration of a build even with the tab in the background.
  useVisiblePolling(fetchProvisionJobs, JOB_POLL_MS, hasActiveJobs);

  const isRegionProvisioning = useCallback(
    (regionKey: string) =>
      jobs.some(
        (j) =>
          j.region.toUpperCase() === regionKey.toUpperCase() &&
          (j.status === 'RUNNING' || j.status === 'PENDING'),
      ),
    [jobs],
  );

  return {
    jobs,
    activeJobs,
    finishedJobs,
    failedJobs,
    completedJobs,
    hasActiveJobs,
    fetchProvisionJobs,
    cancelJob,
    dismissJob,
    isRegionProvisioning,
  };
}

// Provisioning jobs: list + 3s polling while any job is RUNNING/PENDING.
// Splits jobs into active vs finished so callers can render them in
// separate sections.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ProvisionJob } from '../helpers';

export function useProvisionJobs() {
  const [jobs, setJobs] = useState<ProvisionJob[]>([]);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

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

  // Poll regions + jobs every 3s while anything is in flight. Mirrors the
  // original RegionBuilder behaviour exactly, including the cleanup branch.
  useEffect(() => {
    if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; }
    if (!hasActiveJobs) return;
    pollRef.current = setInterval(() => {
      fetchProvisionJobs();
    }, 3000);
    return () => { if (pollRef.current) clearInterval(pollRef.current); };
  }, [hasActiveJobs, fetchProvisionJobs]);

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

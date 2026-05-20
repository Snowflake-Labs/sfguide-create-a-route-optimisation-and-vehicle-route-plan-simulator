// Owns the studio jobs list (active + history). Returns the latest active
// jobs from fetchJobs() so the SSE reconnection effect can wire up to a
// running job on mount.

import { useCallback, useState } from 'react';
import { JobInfo } from '../helpers';
import type { JobHistoryRow } from '../types';

export function useStudioJobs() {
  const [activeJobs, setActiveJobs] = useState<JobInfo[]>([]);
  const [jobHistory, setJobHistory] = useState<JobHistoryRow[]>([]);

  const fetchJobs = useCallback(async (): Promise<JobInfo[]> => {
    try {
      const res = await fetch('/api/studio/jobs');
      const data = await res.json();
      setActiveJobs(data.active || []);
      setJobHistory((data.history || []).filter((j: any) => j.STATUS !== 'DELETED'));
      return data.active || [];
    } catch (e: any) {
      console.error('Failed to fetch jobs:', e);
      return [];
    }
  }, []);

  return { activeJobs, jobHistory, setActiveJobs, fetchJobs };
}

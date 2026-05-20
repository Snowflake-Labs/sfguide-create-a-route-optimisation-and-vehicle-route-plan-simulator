// SSE lifecycle for the active generation job. Owns log lines, generating
// flag, and the connect/disconnect logic with exponential backoff (up to
// 20 retries / 30s cap). Also owns the auto-reconnect to a RUNNING job on
// mount via reconnectedRef.

import { useCallback, useEffect, useRef, useState } from 'react';
import { JobInfo } from '../helpers';

type Refreshers = {
  fetchJobs: () => Promise<JobInfo[]>;
  fetchStats: () => void;
  fetchCoverage: () => void;
};

export function useStudioStream(
  refreshers: Refreshers,
  setActiveJobs: (updater: (prev: JobInfo[]) => JobInfo[]) => void,
) {
  const { fetchJobs, fetchStats, fetchCoverage } = refreshers;
  const [generating, setGenerating] = useState(false);
  const [logLines, setLogLines] = useState<string[]>([]);
  const evtSourceRef = useRef<EventSource | null>(null);
  const retryCountRef = useRef(0);
  const retryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const reconnectedRef = useRef(false);

  const connectSSE = useCallback((jobId: string) => {
    evtSourceRef.current?.close();
    const evtSource = new EventSource(`/api/studio/jobs/${jobId}/stream`);
    evtSourceRef.current = evtSource;

    evtSource.addEventListener('progress', (e) => {
      if (!e.data) return;
      retryCountRef.current = 0;
      const data = JSON.parse(e.data);
      if (data._replay) return;
      let msg = data.status || JSON.stringify(data);
      if (data.routeFailures > 0) msg += ` (${data.routeFailures} route failures)`;
      setLogLines((prev) => [...prev.slice(-50), msg]);
      setActiveJobs((prev) => prev.map((j) => j.jobId === jobId
        ? { ...j, pointsGenerated: data.totalPoints || j.pointsGenerated, tripsGenerated: data.totalTrips || j.tripsGenerated }
        : j));
    });
    evtSource.addEventListener('batch', (e) => {
      if (!e.data) return;
      retryCountRef.current = 0;
      const data = JSON.parse(e.data);
      if (data._replay) return;
      setLogLines((prev) => [...prev.slice(-50), `Batch: ${data.inserted?.toLocaleString()} pts (total: ${data.total?.toLocaleString()})`]);
    });
    evtSource.addEventListener('warning', (e) => {
      if (!e.data) return;
      const data = JSON.parse(e.data);
      if (data._replay) return;
      setLogLines((prev) => [...prev.slice(-50), `WARNING: ${data.message}`]);
      console.warn('[Studio SSE warning]', data.message);
    });
    evtSource.addEventListener('complete', (e) => {
      if (!e.data) return;
      const data = JSON.parse(e.data);
      if (data._replay) return;
      setLogLines((prev) => [...prev, `Complete: ${data.pointsGenerated?.toLocaleString()} points, ${data.tripsGenerated?.toLocaleString()} trips`]);
      setGenerating(false);
      evtSource.close();
      fetchJobs(); fetchStats(); fetchCoverage();
    });
    evtSource.addEventListener('stopped', (e) => {
      if (!e.data) return;
      const d = JSON.parse(e.data);
      if (d._replay) return;
      setLogLines((prev) => [
        ...prev,
        '--- Generation Stopped ---',
        `Reason: ${d.reason}`,
        `Days completed: ${d.completedDays} / ${d.totalDays}`,
        `Points generated: ${d.pointsGenerated?.toLocaleString()}`,
        `Trips generated: ${d.tripsGenerated?.toLocaleString()}`,
        `Routes: ${d.routeSuccesses} succeeded, ${d.routeFailures} failed`,
        'Data saved. Resume ORS and re-run to complete remaining days.',
      ]);
      setGenerating(false);
      evtSource.close();
      fetchJobs(); fetchStats(); fetchCoverage();
    });
    evtSource.addEventListener('error', (e: any) => {
      evtSource.close();
      let isServerError = false;
      try {
        const errData = JSON.parse(e.data);
        setLogLines((prev) => [...prev, `Error: ${errData.error}`]);
        isServerError = true;
      } catch (e: any) {
        console.error('SSE error parse failed (likely a connection drop, not a server error):', e);
      }
      if (isServerError) {
        setGenerating(false);
        fetchJobs();
        return;
      }
      if (retryCountRef.current >= 20) {
        setLogLines((prev) => [...prev, 'Connection lost after 20 retries. Job may still be running server-side.']);
        setGenerating(false);
        fetchJobs();
        return;
      }
      const delay = Math.min(1000 * Math.pow(2, retryCountRef.current), 30000);
      retryCountRef.current++;
      setLogLines((prev) => [...prev, `Connection lost, retrying in ${(delay / 1000).toFixed(0)}s (attempt ${retryCountRef.current}/20)...`]);
      retryTimerRef.current = setTimeout(() => connectSSE(jobId), delay);
    });
    evtSource.addEventListener('cancelled', (e: any) => {
      try {
        const data = e?.data ? JSON.parse(e.data) : {};
        if (data._replay) return;
      } catch {}
      setLogLines((prev) => [...prev, 'Job cancelled']);
      setGenerating(false);
      evtSource.close();
      fetchJobs();
    });
  }, [fetchJobs, fetchStats, fetchCoverage, setActiveJobs]);

  // Cleanup on unmount.
  useEffect(() => {
    return () => {
      evtSourceRef.current?.close();
      if (retryTimerRef.current) clearTimeout(retryTimerRef.current);
    };
  }, []);

  // Auto-attach to a RUNNING job on mount, exactly once.
  useEffect(() => {
    if (reconnectedRef.current) return;
    reconnectedRef.current = true;
    (async () => {
      const jobs = await fetchJobs();
      const running = jobs.find((j: any) => j.status === 'RUNNING');
      if (running) {
        setGenerating(true);
        setLogLines([
          `Reconnected to running job: ${running.jobId}`,
          `${running.presetName} | ${running.region} | ${running.orsProfile}`,
          `Progress: ${running.pointsGenerated?.toLocaleString() || 0} pts, ${running.tripsGenerated?.toLocaleString() || 0} trips`,
        ]);
        connectSSE(running.jobId);
      }
    })();
  }, [fetchJobs, connectSSE]);

  const resetForStart = useCallback(() => {
    retryCountRef.current = 0;
  }, []);

  return {
    generating, setGenerating,
    logLines, setLogLines,
    connectSSE, resetForStart,
  };
}

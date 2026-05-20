// Job-detail drawer state: snapshot fetch, optional SSE attach for RUNNING
// jobs, log line accumulation. Identical behaviour to the inline drawer in
// FleetDataStudio.tsx.

import { useCallback, useEffect, useRef, useState } from 'react';
import type { DetailMeta } from '../types';

function formatEventLine(event: string, data: any): string | string[] | null {
  if (!data) return null;
  switch (event) {
    case 'started':
      return `Job started: ${data.presetName || ''} | ${data.region || ''} | ${data.orsProfile || ''}`;
    case 'progress': {
      let msg = data.status || JSON.stringify(data);
      if (data.routeFailures > 0) msg += ` (${data.routeFailures} route failures)`;
      return msg;
    }
    case 'batch':
      return `Batch: ${Number(data.inserted || 0).toLocaleString()} pts (total: ${Number(data.total || 0).toLocaleString()})`;
    case 'warning':
      return `WARNING: ${data.message}`;
    case 'complete':
      return `Complete: ${Number(data.pointsGenerated || 0).toLocaleString()} points, ${Number(data.tripsGenerated || 0).toLocaleString()} trips`;
    case 'stopped':
      return [
        '--- Generation Stopped ---',
        `Reason: ${data.reason}`,
        `Days completed: ${data.completedDays} / ${data.totalDays}`,
        `Points generated: ${Number(data.pointsGenerated || 0).toLocaleString()}`,
        `Trips generated: ${Number(data.tripsGenerated || 0).toLocaleString()}`,
        `Routes: ${data.routeSuccesses} succeeded, ${data.routeFailures} failed`,
      ];
    case 'error':
      return `Error: ${data.error}`;
    case 'cancelled':
      return 'Job cancelled';
    case 'status':
      return `Status: ${data.status} (points: ${Number(data.points || 0).toLocaleString()}, trips: ${Number(data.trips || 0).toLocaleString()})`;
    default:
      return null;
  }
}

export function useJobDetail() {
  const [selectedJobId, setSelectedJobId] = useState<string | null>(null);
  const [detailLines, setDetailLines] = useState<string[]>([]);
  const [detailMeta, setDetailMeta] = useState<DetailMeta>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const detailEvtRef = useRef<EventSource | null>(null);

  const appendDetailLine = useCallback((line: string | string[] | null) => {
    if (line == null) return;
    setDetailLines((prev) => Array.isArray(line) ? [...prev, ...line] : [...prev, line]);
  }, []);

  const closeJobDetail = useCallback(() => {
    detailEvtRef.current?.close();
    detailEvtRef.current = null;
    setSelectedJobId(null);
    setDetailLines([]);
    setDetailMeta(null);
    setDetailLoading(false);
  }, []);

  const openJobDetail = useCallback(async (jobId: string, status: string) => {
    detailEvtRef.current?.close();
    detailEvtRef.current = null;
    setSelectedJobId(jobId);
    setDetailLines([]);
    setDetailMeta(null);
    setDetailLoading(true);

    const tryFetchSnapshot = async () => {
      try {
        const res = await fetch(`/api/studio/jobs/${jobId}/logs`);
        if (!res.ok) {
          setDetailLines(['(Failed to load logs)']);
          return null;
        }
        const data = await res.json();
        setDetailMeta(data);
        const lines: string[] = [];
        for (const ev of data.events || []) {
          const formatted = formatEventLine(ev.event, ev.data);
          if (Array.isArray(formatted)) lines.push(...formatted);
          else if (formatted) lines.push(formatted);
        }
        if (lines.length === 0) lines.push('(No log events recorded for this job)');
        setDetailLines(lines);
        return data;
      } catch (e: any) {
        setDetailLines([`(Error loading logs: ${e.message})`]);
        return null;
      }
    };

    if (status !== 'RUNNING') {
      await tryFetchSnapshot();
      setDetailLoading(false);
      return;
    }

    const evt = new EventSource(`/api/studio/jobs/${jobId}/stream`);
    detailEvtRef.current = evt;
    let gotAnyEvent = false;
    const handler = (event: string) => (e: any) => {
      if (!e.data) return;
      gotAnyEvent = true;
      try {
        const data = JSON.parse(e.data);
        appendDetailLine(formatEventLine(event, data));
        if (event === 'progress') {
          setDetailMeta((prev: any) => ({ ...(prev || {}), pointsGenerated: data.totalPoints ?? prev?.pointsGenerated, tripsGenerated: data.totalTrips ?? prev?.tripsGenerated }));
        }
      } catch {}
    };
    ['status', 'started', 'progress', 'batch', 'warning', 'complete', 'stopped', 'cancelled'].forEach((ev) =>
      evt.addEventListener(ev, handler(ev)),
    );
    evt.addEventListener('replay-end', () => {
      setDetailLoading(false);
      appendDetailLine('--- Live ---');
    });
    evt.addEventListener('error', async () => {
      evt.close();
      detailEvtRef.current = null;
      if (!gotAnyEvent) {
        await tryFetchSnapshot();
      }
      setDetailLoading(false);
    });
  }, [appendDetailLine]);

  useEffect(() => {
    return () => { detailEvtRef.current?.close(); };
  }, []);

  return {
    selectedJobId,
    detailLines,
    detailMeta,
    detailLoading,
    openJobDetail,
    closeJobDetail,
  };
}

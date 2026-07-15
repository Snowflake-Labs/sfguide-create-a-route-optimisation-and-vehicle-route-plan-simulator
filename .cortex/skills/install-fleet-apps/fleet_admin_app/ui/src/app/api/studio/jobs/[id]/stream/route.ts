import { NextRequest } from 'next/server';
import { getJob, getJobEvents, subscribeJob } from '@/server/studio/jobs';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// SSE stream of generation-job events. Express used res.write; in Next App Router
// we return a ReadableStream Response. Replays buffered events, then live-subscribes
// with a 5s heartbeat to survive SPCS ingress idle timeouts.
export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id: jobId } = await ctx.params;
  const job = getJob(jobId);
  if (!job) return new Response(JSON.stringify({ error: 'Job not found' }), { status: 404, headers: { 'Content-Type': 'application/json' } });

  const encoder = new TextEncoder();
  let heartbeat: ReturnType<typeof setInterval> | null = null;
  let unsub: (() => void) | null = null;

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const send = (event: string, data: unknown) => {
        try { controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)); } catch { /* closed */ }
      };
      send('status', { jobId, status: job.status, points: job.pointsGenerated, trips: job.tripsGenerated });
      const buffered = getJobEvents(jobId) || [];
      for (const ev of buffered) send(ev.event, { ...ev.data, _replay: true, _ts: ev.ts });
      send('replay-end', { jobId, count: buffered.length });

      if (job.status !== 'RUNNING') {
        send(job.status === 'COMPLETED' ? 'complete' : job.status === 'STOPPED' ? 'stopped' : 'error', { status: job.status });
        controller.close();
        return;
      }

      heartbeat = setInterval(() => {
        try { controller.enqueue(encoder.encode(': heartbeat\n\n')); } catch { /* closed */ }
      }, 5000);
      unsub = subscribeJob(jobId, send);

      // Client disconnect -> tear down subscription + heartbeat.
      req.signal.addEventListener('abort', () => {
        if (heartbeat) clearInterval(heartbeat);
        if (unsub) unsub();
        try { controller.close(); } catch { /* already closed */ }
      });
    },
    cancel() {
      if (heartbeat) clearInterval(heartbeat);
      if (unsub) unsub();
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    },
  });
}

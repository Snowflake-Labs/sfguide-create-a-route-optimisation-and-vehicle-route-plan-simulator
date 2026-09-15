import { defineProc, t } from '@snowflake/synapse';

/**
 * Graph-build history and service logs for one region.
 *
 * WHY BOTH IN ONE VERB
 * --------------------
 * "Why did the Europe build fail" is answered by neither half alone.
 * ORS_BUILD_HISTORY records what the build attempted and how it exited (instance
 * family, heap, elapsed minutes, peak RSS, output graph size), which is where an
 * out-of-memory build is visible as a resource fact. The service log is where
 * the actual error text lives. An agent that could read only one would either
 * quote an exit status with no cause, or a stack trace with no context.
 *
 * Read-only, and it does NOT wake the service: SYSTEM$GET_SERVICE_LOGS reads
 * whatever the running (or last-run) container emitted.
 *
 * Log line count is capped at 400. This is deliberately lower than the admin
 * app's 1000: a log tail goes straight into the model's context window, and a
 * thousand lines of Java logging is both expensive and worse to reason over than
 * the tail that actually contains the failure.
 */
export const region_diagnostics = defineProc({
  name: 'region_diagnostics',
  description:
    'Diagnose a routing region: its graph-build history (compute size, heap, elapsed minutes, ' +
    'exit status, peak memory, output graph size) plus the tail of its ORS service log. Use for ' +
    '"why did the build for X fail", "why is region X unhealthy", "how long did the last build ' +
    'take", "show me the routing logs". Read-only: it does not wake or restart anything. Reads ' +
    'log instance 0 only, so on a multi-instance service it shows one container.',
  roles: ['ops'],
  args: {
    region: t
      .string({ min: 1, max: 80 })
      .describe('Region to diagnose, e.g. "SanFrancisco".'),
    log_lines: t
      .number()
      .nullable()
      .describe(
        'Optional number of trailing log lines, 10 to 400. Defaults to 120. Ask for more only ' +
          'when the failure is not in the tail.',
      ),
  },
  returns: {
    result: t
      .object({})
      .describe('build_history[], service_log (string), log_lines_returned, and a summary.'),
  },
  execute: async (args, ctx) => {
    // Region reaches an object identifier, so restrict it to identifier-safe
    // characters rather than relying on quoting downstream.
    const region = String(args.region).replace(/[^A-Za-z0-9_]/g, '');
    const requested = args.log_lines == null ? 120 : Number(args.log_lines);
    const lines = Math.min(Math.max(Number.isFinite(requested) ? requested : 120, 10), 400);

    let history: Record<string, unknown>[] = [];
    try {
      const raw = await ctx.conn.execScalar<string>(
        `SELECT COALESCE(ARRAY_AGG(OBJECT_CONSTRUCT(
             'build_id', BUILD_ID, 'job_id', JOB_ID, 'region', REGION,
             'instance_family', INSTANCE_FAMILY, 'compute_size', COMPUTE_SIZE,
             'profiles', PROFILES, 'jvm_xmx_gib', JVM_XMX_GIB,
             'started_at', TO_VARCHAR(STARTED_AT), 'finished_at', TO_VARCHAR(FINISHED_AT),
             'elapsed_minutes', ELAPSED_MINUTES, 'exit_status', EXIT_STATUS,
             'peak_rss_gib', PEAK_RSS_GIB, 'output_graph_gib', OUTPUT_GRAPH_GIB
           )) WITHIN GROUP (ORDER BY STARTED_AT DESC), ARRAY_CONSTRUCT())::STRING
         FROM (
           SELECT *
           FROM OPENROUTESERVICE_APP.CORE.ORS_BUILD_HISTORY
           WHERE UPPER(REGION) = UPPER(?)
           ORDER BY STARTED_AT DESC
           LIMIT 10
         )`,
        [region],
      );
      const parsed = raw == null ? [] : JSON.parse(String(raw));
      if (Array.isArray(parsed)) history = parsed as Record<string, unknown>[];
    } catch (e) {
      history = [{ error: (e as Error).message }];
    }

    let log = '';
    let logError: string | null = null;
    try {
      // Line count is interpolated because it is a clamped integer above;
      // the service name is built from the sanitized region.
      const svc = `OPENROUTESERVICE_APP.CORE.ORS_SERVICE_${region.toUpperCase()}`;
      const raw = await ctx.conn.execScalar<string>(
        `SELECT SYSTEM$GET_SERVICE_LOGS('${svc}', 0, 'ors', ${lines})`,
      );
      log = raw == null ? '' : String(raw);
    } catch (e) {
      logError = (e as Error).message;
    }

    const tail = log ? log.split(/\r?\n/).slice(-lines) : [];
    const last = history.find((h) => h.exit_status != null);
    const summary =
      (history.length
        ? `${history.length} build(s) recorded for ${region}` +
          (last ? `; most recent exited ${last.exit_status} after ${last.elapsed_minutes} min.` : '.')
        : `No graph-build history recorded for ${region}.`) +
      (logError
        ? ` Service log unavailable: ${logError}. A suspended service keeps no live log, which is normal when the region is idle.`
        : ` ${tail.length} log line(s) returned.`);

    return {
      result: {
        region,
        build_history: history,
        service_log: tail.join('\n'),
        log_lines_returned: tail.length,
        log_error: logError,
        summary,
      },
    };
  },
});

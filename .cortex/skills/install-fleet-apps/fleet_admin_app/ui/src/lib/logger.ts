// Framework-level structured logger.
// Outputs one JSON line per call to stdout so SYSTEM$GET_SERVICE_LOGS captures it.
// LOG_LEVEL env var controls verbosity: debug | info | warn | error (default: info)

type Level = 'debug' | 'info' | 'warn' | 'error';

const LEVELS: Record<Level, number> = { debug: 0, info: 1, warn: 2, error: 3 };

function getMinLevel(): number {
  const env = (process.env.LOG_LEVEL ?? 'info').toLowerCase() as Level;
  return LEVELS[env] ?? LEVELS.info;
}

function write(level: Level, msg: string, ctx?: Record<string, unknown>, err?: unknown): void {
  if (LEVELS[level] < getMinLevel()) return;
  const entry: Record<string, unknown> = {
    ts: new Date().toISOString(),
    level,
    msg,
    ...ctx,
  };
  if (err instanceof Error) {
    entry.error = err.message;
    if (err.stack) entry.stack = err.stack.split('\n').slice(0, 4).join(' | ');
  } else if (err !== undefined) {
    entry.error = String(err);
  }
  console.log(JSON.stringify(entry));
}

export const logger = {
  debug: (msg: string, ctx?: Record<string, unknown>) => write('debug', msg, ctx),
  info:  (msg: string, ctx?: Record<string, unknown>) => write('info',  msg, ctx),
  warn:  (msg: string, ctx?: Record<string, unknown>) => write('warn',  msg, ctx),
  error: (msg: string, ctx?: Record<string, unknown>, err?: unknown) => write('error', msg, ctx, err),
};

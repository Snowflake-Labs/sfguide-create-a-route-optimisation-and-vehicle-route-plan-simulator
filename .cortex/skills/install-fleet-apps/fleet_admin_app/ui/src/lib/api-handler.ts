// Framework-level route handler wrapper.
// Wraps any Next.js App Router route handler with structured request/response logging.
//
// Usage:
//   export const POST = withLogging(async (req) => { ... });

import { NextRequest, NextResponse } from 'next/server';
import { logger } from './logger';

type RouteHandler = (req: NextRequest, ctx?: unknown) => Promise<Response>;

export function withLogging(handler: RouteHandler): RouteHandler {
  return async (req: NextRequest, ctx?: unknown): Promise<Response> => {
    const reqId = crypto.randomUUID().slice(0, 8);
    const method = req.method;
    const path = new URL(req.url).pathname;
    const start = Date.now();

    logger.info('api-req', { method, path, reqId });

    try {
      const response = await handler(req, ctx);
      const ms = Date.now() - start;
      logger.info('api-res', { method, path, status: response.status, ms, reqId });
      return response;
    } catch (err) {
      const ms = Date.now() - start;
      logger.error('api-err', { method, path, ms, reqId }, err);
      return NextResponse.json(
        { error: err instanceof Error ? err.message : 'Internal server error' },
        { status: 500 },
      );
    }
  };
}

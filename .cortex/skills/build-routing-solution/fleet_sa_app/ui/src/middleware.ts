// Next.js middleware — runs before every request.
// Logs HTTP arrival at debug level so we can confirm requests reach the container
// even when route handlers fail or the SPCS proxy returns an error.
//
// Skips static asset paths to keep logs clean.

import { NextRequest, NextResponse } from 'next/server';
import { logger } from '@/lib/logger';

const SKIP_PREFIXES = ['/_next/', '/favicon.ico', '/static/'];

export function middleware(req: NextRequest) {
  const path = req.nextUrl.pathname;

  if (!SKIP_PREFIXES.some((p) => path.startsWith(p))) {
    logger.debug('http', {
      method: req.method,
      path,
      ua: req.headers.get('user-agent')?.slice(0, 60) ?? undefined,
    });
  }

  return NextResponse.next();
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
};

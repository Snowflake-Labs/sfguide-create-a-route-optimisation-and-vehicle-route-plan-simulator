import { NextResponse } from 'next/server';
import { withLogging } from '@/lib/api-handler';
import { clearEntries } from '@/server/diagnostics';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const POST = withLogging(async () => {
  clearEntries();
  return NextResponse.json({ ok: true });
});

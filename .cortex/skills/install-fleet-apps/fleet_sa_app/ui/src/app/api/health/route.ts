import { NextResponse } from 'next/server';
import { withLogging } from '@/lib/api-handler';

export const GET = withLogging(async () => {
  return NextResponse.json({ status: 'ok' });
});

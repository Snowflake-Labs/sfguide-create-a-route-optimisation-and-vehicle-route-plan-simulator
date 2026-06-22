import { NextResponse } from 'next/server';
import { withLogging } from '@/lib/api-handler';
import { PROFILE_TEMPLATES } from '@/server/studio/profiles';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const GET = withLogging(async () => {
  return NextResponse.json(PROFILE_TEMPLATES.map((t) => ({
    id: t.id, name: t.name, description: t.description, vehicleType: t.vehicleType,
    orsProfile: t.orsProfile, regionScale: t.regionScale, feeds: t.feeds, defaultConfig: t.defaultConfig,
  })));
});

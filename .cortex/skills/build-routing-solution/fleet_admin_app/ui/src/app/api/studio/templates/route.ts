import { NextResponse } from 'next/server';
import { withLogging } from '@/lib/api-handler';
import { PROFILE_TEMPLATES } from '@/server/studio/profiles';
import { runSql } from '@/server/lib/sql';
import { listGenerationProfiles } from '@/server/studio/generation-profile-catalog';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const GET = withLogging(async () => {
  // Prefer the data-driven catalog (so user-added profile rows show up); fall
  // back to the in-memory built-in templates if it's unavailable.
  const fromCatalog = await listGenerationProfiles(runSql);
  const source = fromCatalog ?? PROFILE_TEMPLATES;
  return NextResponse.json(source.map((t: any) => ({
    id: t.id, name: t.name, description: t.description, vehicleType: t.vehicleType,
    orsProfile: t.orsProfile, regionScale: t.regionScale, feeds: t.feeds, defaultConfig: t.defaultConfig,
  })));
});

import { NextResponse } from 'next/server';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { logger } from '@/lib/logger';
import { withLogging } from '@/lib/api-handler';

// Canonical format: flat object keyed by view ID.
// { "campaign_performance": { "label": "...", "layout": {...}, "areas": {...} } }
async function handleGet() {
  const configPath = process.env.APP_VIEWS_CONFIG;
  if (!configPath) {
    return NextResponse.json({});
  }

  try {
    const fullPath = configPath.startsWith('/') ? configPath : resolve(process.cwd(), configPath);
    const raw = readFileSync(fullPath, 'utf-8');
    return NextResponse.json(JSON.parse(raw));
  } catch (err) {
    logger.error('views-config-load', { path: configPath }, err);
    return NextResponse.json({});
  }
}

export const GET = withLogging(handleGet);

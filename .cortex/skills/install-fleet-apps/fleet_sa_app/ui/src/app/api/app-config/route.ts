import { NextResponse } from 'next/server';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { logger } from '@/lib/logger';
import { withLogging } from '@/lib/api-handler';

export interface AppConfig {
  name: string;
  description: string;
  targetUsers: string[];
  capabilities: string[];
  sampleQuestions: string[];
}

const DEFAULT_CONFIG: AppConfig = {
  name: 'Data App',
  description: '',
  targetUsers: [],
  capabilities: [],
  sampleQuestions: [],
};

async function handleGet() {
  const configPath = process.env.APP_CONFIG;
  if (!configPath) {
    return NextResponse.json(DEFAULT_CONFIG);
  }

  try {
    const fullPath = configPath.startsWith('/') ? configPath : resolve(process.cwd(), configPath);
    const raw = readFileSync(fullPath, 'utf-8');
    return NextResponse.json({ ...DEFAULT_CONFIG, ...JSON.parse(raw) });
  } catch (err) {
    logger.error('app-config-load', { path: configPath }, err);
    return NextResponse.json(DEFAULT_CONFIG);
  }
}

export const GET = withLogging(handleGet);

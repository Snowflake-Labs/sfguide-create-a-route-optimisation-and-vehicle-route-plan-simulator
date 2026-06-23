// Shared server-side reader for the app bundle's app-config.json.
//
// The client fetches the same file via /api/app-config; the Node API routes
// (tool / ops / region) need it too, to read the domain's tool schema, verb
// allowlist, and region/context config instead of hardcoding fleet literals.
// Resolution mirrors api/app-config/route.ts: APP_CONFIG points at the JSON
// file (absolute, or relative to cwd). The parsed object is cached by resolved
// path so each request doesn't re-read from disk.
//
// Every section is OPTIONAL. When a section is absent the calling route falls
// back to its previous literal default, so an unextended config (or a missing
// APP_CONFIG) behaves exactly as before.

import { readFileSync } from 'fs';
import { resolve } from 'path';
import { logger } from './logger';
import type { DisplayConfig } from './types';

export interface ToolsConfig {
  // Fully-qualified schema holding the user routing verbs (e.g. DB.SCHEMA).
  schema?: string;
  // verb -> number of business args (excluding the trailing IDEMPOTENCY_KEY).
  verbs?: Record<string, number>;
  // Tool names whose result geometry renders on an inline deck.gl map.
  mapTools?: string[];
}

export interface OpsConfig {
  schema?: string;
  verbs?: Record<string, number>;
}

export interface RegionConfig {
  // Database holding the per-schema CONFIG tables.
  database?: string;
  // Schemas whose CONFIG table carries the context columns.
  schemas?: string[];
}

export interface DataLayerConfig {
  // Neutral database the YAML dashboards + surfacing-gate probe bind to.
  // Defaults to FLEET_APP when absent (fleet back-compat).
  database?: string;
}

export interface ContextBarField {
  id: string;
  type?: string;
  label?: string;
  default?: string;
  configColumn?: string;
  options?: { value: string; label: string }[];
}

export interface ServerConfig {
  name?: string;
  domainPack?: string;
  snowflake?: { database?: string; schema?: string };
  contextBar?: ContextBarField[];
  tools?: ToolsConfig;
  ops?: OpsConfig;
  region?: RegionConfig;
  dataLayer?: DataLayerConfig;
  // Zero-code retargeting surface (labels/units/thresholds/statusEnums/icons/windows).
  display?: DisplayConfig;
}

const cache = new Map<string, ServerConfig>();

export function getServerConfig(): ServerConfig {
  const configPath = process.env.APP_CONFIG;
  if (!configPath) return {};

  const fullPath = configPath.startsWith('/') ? configPath : resolve(process.cwd(), configPath);
  const cached = cache.get(fullPath);
  if (cached) return cached;

  try {
    const raw = readFileSync(fullPath, 'utf-8');
    const parsed = JSON.parse(raw) as ServerConfig;
    cache.set(fullPath, parsed);
    return parsed;
  } catch (err) {
    logger.error('server-config-load', { path: configPath }, err);
    return {};
  }
}

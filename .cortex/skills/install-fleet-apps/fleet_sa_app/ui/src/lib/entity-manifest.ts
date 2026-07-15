import { readFileSync } from 'fs';
import { join } from 'path';

export interface EntityDef {
  table: string;
  primary_key: string;
  soft_delete: boolean;
  writable_columns: string[];
  unique_columns?: string[];
}

export interface EntityManifest {
  schema: string;
  entities: Record<string, EntityDef>;
}

function loadManifest(): EntityManifest {
  const path = process.env.ENTITY_MANIFEST;
  if (!path) throw new Error('ENTITY_MANIFEST env var is not set');
  const full = path.startsWith('/') ? path : join(process.cwd(), path);
  const raw = readFileSync(full, 'utf-8');
  return JSON.parse(raw) as EntityManifest;
}

// Cached at module load; safe because the manifest is static per deployment.
let _manifest: EntityManifest | null = null;
export function getManifest(): EntityManifest {
  // Always reload in development so manifest changes are picked up without a restart
  if (!_manifest || process.env.NODE_ENV === 'development') _manifest = loadManifest();
  return _manifest;
}

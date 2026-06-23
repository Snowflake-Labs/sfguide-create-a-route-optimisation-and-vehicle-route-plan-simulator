// Validator for agent-emitted (dynamic) view specs.
//
// An agent (via the render_view synapse verb) can emit a declarative page spec
// that the existing ViewRenderer interprets. Because that content is
// prompt-generated and untrusted, it MUST be validated before it is registered
// and rendered. This is the authoritative client-side gate (the verb performs a
// lighter server-side structural check for early agent self-correction).
//
// Hand-rolled (no zod dependency) — the spec shape is small and the data boundary
// is enforced separately by /api/query (dynamic:true -> owner's-rights
// FLEET_APP_DYNAMIC_READER). Mirrors ParsedViewDef / AreaConfig from view-renderer.tsx.
import { AREA_COMPONENT_NAMES } from '@/lib/area-components';
import type { ParsedViewDef } from '@/components/views/view-renderer';

const ALLOWED_COMPONENTS = new Set<string>(AREA_COMPONENT_NAMES);
const MAX_TITLE_LEN = 200;
const MAX_TEXT_LEN = 2000;

export interface ParseOk {
  ok: true;
  spec: ParsedViewDef;
}
export interface ParseErr {
  ok: false;
  errors: string[];
}
export type ParseResult = ParseOk | ParseErr;

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function clampString(v: unknown, max: number, fallback = ''): string {
  return typeof v === 'string' ? v.slice(0, max) : fallback;
}

function queryLooksReadOnly(q: string): boolean {
  const head = q.trim().toUpperCase();
  return head.startsWith('SELECT') || head.startsWith('WITH');
}

// Validate + normalize a raw spec (object or JSON string) into a ParsedViewDef.
// On success returns a spec with a fixed reserved id; on failure returns the
// list of problems (surfaced to the user, not silently dropped).
export function parseDynamicSpec(raw: unknown, id = '__dynamic__'): ParseResult {
  const errors: string[] = [];

  let obj: unknown = raw;
  if (typeof raw === 'string') {
    try {
      obj = JSON.parse(raw);
    } catch (e) {
      return { ok: false, errors: [`spec is not valid JSON: ${(e as Error).message}`] };
    }
  }
  if (!isObject(obj)) {
    return { ok: false, errors: ['spec must be a JSON object'] };
  }

  // layout.default.grid (string) is required; columns defaults to "1fr".
  const layout = obj.layout;
  if (!isObject(layout) || !isObject(layout.default) || typeof layout.default.grid !== 'string') {
    errors.push('layout.default.grid (string) is required');
  }

  // areas: non-empty object; each area.component must be in the allowlist; any
  // area.data.query must be read-only (SELECT/WITH).
  const areas = obj.areas;
  const cleanAreas: Record<string, unknown> = {};
  if (!isObject(areas) || Object.keys(areas).length === 0) {
    errors.push('areas must be a non-empty object');
  } else {
    for (const [name, areaRaw] of Object.entries(areas)) {
      if (!isObject(areaRaw)) {
        errors.push(`area '${name}' must be an object`);
        continue;
      }
      const comp = areaRaw.component;
      if (typeof comp !== 'string' || !ALLOWED_COMPONENTS.has(comp)) {
        errors.push(
          `area '${name}' component '${String(comp)}' is not allowed (one of: ${AREA_COMPONENT_NAMES.join(', ')})`,
        );
        continue;
      }
      const data = isObject(areaRaw.data) ? areaRaw.data : {};
      const q = data.query;
      if (q !== undefined && (typeof q !== 'string' || !queryLooksReadOnly(q))) {
        errors.push(`area '${name}' data.query must be a SELECT/WITH statement`);
        continue;
      }
      // config is a permissive passthrough (showFreshness/defaultSort/play/layers/...),
      // but clamp any title/tooltip strings.
      const config = isObject(areaRaw.config) ? { ...areaRaw.config } : undefined;
      if (config) {
        if ('title' in config) config.title = clampString(config.title, MAX_TITLE_LEN);
        if ('tooltip' in config) config.tooltip = clampString(config.tooltip, MAX_TEXT_LEN);
      }
      cleanAreas[name] = {
        component: comp,
        data,
        ...(config ? { config } : {}),
        ...(isObject(areaRaw.emits) ? { emits: areaRaw.emits } : {}),
      };
    }
  }

  if (errors.length > 0) return { ok: false, errors };

  const l = layout as { default: Record<string, unknown>; tablet?: unknown; mobile?: unknown };
  const spec: ParsedViewDef = {
    id,
    label: clampString(obj.label, MAX_TITLE_LEN, 'Generated View'),
    description: clampString(obj.description, MAX_TEXT_LEN),
    layout: {
      default: {
        columns: clampString(l.default.columns, 200, '1fr'),
        rows: typeof l.default.rows === 'string' ? l.default.rows : undefined,
        grid: l.default.grid as string,
      },
      ...(isObject(l.tablet) ? { tablet: l.tablet as unknown as ParsedViewDef['layout']['default'] } : {}),
      ...(isObject(l.mobile) ? { mobile: l.mobile as unknown as ParsedViewDef['layout']['default'] } : {}),
    },
    areas: cleanAreas as ParsedViewDef['areas'],
  };
  return { ok: true, spec };
}

// Validator for agent-emitted MAP specs (the `render_map` synapse verb) and for
// the `config.layers` block of a `component: Map` area inside an agent-emitted
// `render_view` page spec.
//
// Why this exists as its own gate: `parseDynamicSpec` treats `config` as a
// permissive passthrough, so before this file an agent-authored Map area reached
// the deck.gl compiler completely unvalidated - an unknown layer `type` compiled
// to nothing and rendered a blank basemap with no error, which is
// indistinguishable from "the query matched no rows". Every failure mode of a
// map is silent, so the spec has to be rejected by name rather than diagnosed
// after the fact.
//
// Hand-rolled to match the house style of view-spec-schema.ts (no zod). The DATA
// boundary is NOT here: it is /api/query with dynamic:true, which runs the query
// as owner's-rights FLEET_APP_DYNAMIC_READER behind ALLOWED_DYNAMIC_DBS. This
// file validates SHAPE and the param-binding contract.
import type { LayerSpec, LegendItem, MapViewStateSpec } from '@/lib/map/layer-spec';

/** Layer types the deck.gl compiler implements. Anything else compiles to null. */
export const MAP_LAYER_TYPES = ['scatterplot', 'path', 'h3', 'geojson', 'arc'] as const;

/** Layers per map. Each layer is one independent query against the warehouse, so
 *  this is a cost bound as much as a legibility one. */
export const MAX_MAP_LAYERS = 4;

/** Inline map height bounds, in px. A chat message is a fixed-height card. */
export const MIN_MAP_HEIGHT = 200;
export const MAX_MAP_HEIGHT = 600;
export const DEFAULT_MAP_HEIGHT = 340;

const MAX_TITLE_LEN = 200;
const MAX_TEXT_LEN = 2000;

/** Area-level keys that only mean something inside an interactive dashboard page.
 *  A chat message has no toggles to tick, no table to click and no viewState to
 *  write, so accepting these would render controls that silently do nothing. */
const INTERACTIVE_KEYS = ['toggles', 'clickEmits', 'focusOn'] as const;

/** A validated inline map spec, as consumed by RenderMapInline. */
export interface InlineMapSpec {
  title?: string;
  height: number;
  layers: LayerSpec[];
  legend?: LegendItem[];
  categoryLegend?: LegendItem[];
  emptyMessage?: string;
  fallback?: MapViewStateSpec;
}

export interface MapParseOk {
  ok: true;
  spec: InlineMapSpec;
}
export interface MapParseErr {
  ok: false;
  errors: string[];
}
export type MapParseResult = MapParseOk | MapParseErr;

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function clampString(v: unknown, max: number): string | undefined {
  return typeof v === 'string' && v.length > 0 ? v.slice(0, max) : undefined;
}

function queryLooksReadOnly(q: string): boolean {
  const head = q.trim().toUpperCase();
  return head.startsWith('SELECT') || head.startsWith('WITH');
}

/**
 * Validate a `layers` array against the DSL the compiler actually implements.
 *
 * `allowViewState` is the one behavioural difference between the two callers. A
 * `render_view` page owns a `panel.viewState`, so `viewState.x` params and
 * `visibleWhen` gating are meaningful there. An inline chat map does not: its
 * params can only resolve from `context.*` (region / vehicle_type / dataset_id /
 * date range) or a literal, and a `viewState.*` ref would resolve to NULL and
 * silently return zero rows - the exact blank-map-without-an-error case this
 * gate exists to prevent.
 *
 * Errors are pushed onto `errors` with a `<prefix>` so the caller can say which
 * area was at fault. Returns the layers it accepted (only meaningful when no
 * error was pushed).
 */
export function validateMapLayers(
  raw: unknown,
  errors: string[],
  opts: { prefix?: string; allowViewState: boolean },
): LayerSpec[] {
  const at = opts.prefix ? `${opts.prefix} ` : '';
  if (!Array.isArray(raw) || raw.length === 0) {
    errors.push(`${at}config.layers must be a non-empty array`);
    return [];
  }
  if (raw.length > MAX_MAP_LAYERS) {
    errors.push(
      `${at}config.layers has ${raw.length} layers, at most ${MAX_MAP_LAYERS} are allowed`,
    );
    return [];
  }
  const out: LayerSpec[] = [];
  raw.forEach((layerRaw, i) => {
    const where = `${at}layer ${i}`;
    if (!isObject(layerRaw)) {
      errors.push(`${where} must be an object`);
      return;
    }
    const type = layerRaw.type;
    if (typeof type !== 'string' || !(MAP_LAYER_TYPES as readonly string[]).includes(type)) {
      errors.push(
        `${where} type '${String(type)}' is not a known layer type (one of: ${MAP_LAYER_TYPES.join(', ')})`,
      );
      return;
    }
    const data = layerRaw.data;
    if (!isObject(data) || typeof data.query !== 'string' || data.query.trim() === '') {
      errors.push(`${where} requires data.query (a SELECT/WITH statement)`);
      return;
    }
    if (!queryLooksReadOnly(data.query)) {
      errors.push(`${where} data.query must be a SELECT/WITH statement`);
      return;
    }
    if (data.params !== undefined) {
      if (!isObject(data.params)) {
        errors.push(`${where} data.params must be an object`);
        return;
      }
      let bad = false;
      for (const [name, ref] of Object.entries(data.params)) {
        if (typeof ref !== 'string') {
          errors.push(`${where} data.params.${name} must be a string`);
          bad = true;
          continue;
        }
        if (!opts.allowViewState && ref.startsWith('viewState.')) {
          errors.push(
            `${where} data.params.${name} binds '${ref}', but an inline map has no view state - bind context.* or a literal`,
          );
          bad = true;
        }
      }
      if (bad) return;
    }
    if (!opts.allowViewState && typeof layerRaw.visibleWhen === 'string') {
      errors.push(`${where} visibleWhen is not supported on an inline map (no toggles to gate it)`);
      return;
    }
    const clean: Record<string, unknown> = { ...layerRaw };
    if (typeof clean.tooltip === 'string') clean.tooltip = clean.tooltip.slice(0, MAX_TEXT_LEN);
    out.push(clean as unknown as LayerSpec);
  });
  return out;
}

/**
 * Validate + normalize a raw inline map spec (object or JSON string).
 *
 * Accepts either the flat shape the `render_map` verb returns
 * (`{layers, title?, height?, legend?, ...}`) or an area-shaped
 * `{config: {layers, ...}}`, since an agent that has learned the `render_view`
 * spec shape will reach for the nested form.
 */
export function parseMapSpec(raw: unknown): MapParseResult {
  let obj: unknown = raw;
  if (typeof raw === 'string') {
    try {
      obj = JSON.parse(raw);
    } catch (e) {
      return { ok: false, errors: [`map spec is not valid JSON: ${(e as Error).message}`] };
    }
  }
  if (!isObject(obj)) {
    return { ok: false, errors: ['map spec must be a JSON object'] };
  }
  // Tolerate the area-shaped form: {component:'Map', config:{layers:[...]}}.
  const body: Record<string, unknown> = isObject(obj.config)
    ? { ...(obj.config as Record<string, unknown>), title: obj.title ?? (obj.config as Record<string, unknown>).title }
    : obj;

  const errors: string[] = [];
  for (const k of INTERACTIVE_KEYS) {
    if (body[k] !== undefined) {
      errors.push(`config.${k} is not supported on an inline map (a chat message has no view state)`);
    }
  }
  const layers = validateMapLayers(body.layers, errors, { allowViewState: false });
  if (errors.length > 0) return { ok: false, errors };

  let height = DEFAULT_MAP_HEIGHT;
  if (body.height !== undefined) {
    const h = Number(body.height);
    if (Number.isFinite(h)) height = Math.min(MAX_MAP_HEIGHT, Math.max(MIN_MAP_HEIGHT, Math.round(h)));
  }

  const legend = Array.isArray(body.legend) ? (body.legend as LegendItem[]) : undefined;
  const categoryLegend = Array.isArray(body.categoryLegend)
    ? (body.categoryLegend as LegendItem[])
    : undefined;

  return {
    ok: true,
    spec: {
      title: clampString(body.title, MAX_TITLE_LEN),
      height,
      layers,
      ...(legend && legend.length ? { legend } : {}),
      ...(categoryLegend && categoryLegend.length ? { categoryLegend } : {}),
      ...(clampString(body.emptyMessage, MAX_TEXT_LEN)
        ? { emptyMessage: clampString(body.emptyMessage, MAX_TEXT_LEN) }
        : {}),
      ...(isObject(body.fallback) ? { fallback: body.fallback as unknown as MapViewStateSpec } : {}),
    },
  };
}

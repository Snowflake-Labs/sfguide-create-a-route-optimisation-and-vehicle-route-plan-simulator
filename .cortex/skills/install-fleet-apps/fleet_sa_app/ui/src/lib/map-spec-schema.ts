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
import type { LayerSpec, LegendItem, MapViewStateSpec, ColorRGBA } from '@/lib/map/layer-spec';

/** Layer types the deck.gl compiler implements. Anything else compiles to null. */
export const MAP_LAYER_TYPES = ['scatterplot', 'path', 'h3', 'geojson', 'arc'] as const;

/** Layers per map. Each layer is one independent query against the warehouse, so
 *  this is a cost bound as much as a legibility one. */
export const MAX_MAP_LAYERS = 4;

/** Legend rows per card. A chat message has no room for a scrolling key. */
export const MAX_LEGEND_ITEMS = 12;

/** Current map spec version.
 *
 *  Unversioned until now, which is only survivable while there is exactly one
 *  producer and one consumer in the same deployment. There are already two
 *  producers (an authored Map area in app-views.json and the `render_map` verb),
 *  and app-views.json is stage-mounted while the validator is compiled into the
 *  image, so the two can be at different revisions on a live app - that is a
 *  diagnosed defect in this repo, not a hypothetical.
 *
 *  Absent is treated as 1, so every existing spec stays valid: the field earns
 *  its keep the first time the shape changes incompatibly, and only if it is
 *  present from before that point. */
export const MAP_SPEC_VERSION = 1;

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
  version: number;
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

/** Parse one legend swatch colour into the compiler's ColorRGBA 4-tuple.
 *
 *  Accepts what the DSL declares (`[r,g,b]` / `[r,g,b,a]`) AND a CSS hex string,
 *  because an LLM writing a legend reaches for `#ffffcc` every time - and the
 *  previous bare `as LegendItem[]` cast let that through to InlineLegend, which
 *  indexes `c[0]` and so built `rgba(#, f, f, ...)`: invalid CSS, transparent
 *  swatch, no error anywhere. Returns null when it is neither. */
export function parseLegendColor(v: unknown): ColorRGBA | null {
  if (typeof v === 'string') {
    const m = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(v.trim());
    if (!m) return null;
    const hex = m[1].length === 3 ? m[1].replace(/./g, (c) => c + c) : m[1];
    return [
      parseInt(hex.slice(0, 2), 16),
      parseInt(hex.slice(2, 4), 16),
      parseInt(hex.slice(4, 6), 16),
      255,
    ];
  }
  if (Array.isArray(v) && (v.length === 3 || v.length === 4)) {
    const nums = v.map((n) => Number(n));
    if (nums.some((n) => !Number.isFinite(n) || n < 0 || n > 255)) return null;
    return [nums[0], nums[1], nums[2], nums.length === 4 ? nums[3] : 255];
  }
  return null;
}

/** Validate one legend array, normalizing every colour to ColorRGBA.
 *
 *  An item with neither `color` nor `gradient` is REJECTED rather than dropped:
 *  it renders as a labelled but invisible swatch, which reads as a rendering bug
 *  in the map itself. */
function validateLegend(raw: unknown, where: string, errors: string[]): LegendItem[] | undefined {
  if (raw === undefined) return undefined;
  if (!Array.isArray(raw)) {
    errors.push(`${where} must be an array`);
    return undefined;
  }
  if (raw.length > MAX_LEGEND_ITEMS) {
    errors.push(`${where} has ${raw.length} items, max ${MAX_LEGEND_ITEMS}`);
    return undefined;
  }
  const out: LegendItem[] = [];
  raw.forEach((entry, i) => {
    const at = `${where}[${i}]`;
    if (!isObject(entry)) {
      errors.push(`${at} must be an object`);
      return;
    }
    const label = clampString(entry.label, MAX_TITLE_LEN);
    if (!label) {
      errors.push(`${at}.label is required`);
      return;
    }
    const item: LegendItem = { label };
    if (entry.color !== undefined) {
      const c = parseLegendColor(entry.color);
      if (!c) {
        errors.push(
          `${at}.color must be [r,g,b] / [r,g,b,a] with 0-255 values or a hex string like '#ffffcc', got ${JSON.stringify(entry.color)}`,
        );
        return;
      }
      item.color = c;
    }
    if (entry.gradient !== undefined) {
      if (!Array.isArray(entry.gradient) || entry.gradient.length < 2) {
        errors.push(`${at}.gradient must be an array of at least 2 colours`);
        return;
      }
      const stops: ColorRGBA[] = [];
      for (const g of entry.gradient) {
        const c = parseLegendColor(g);
        if (!c) {
          errors.push(`${at}.gradient contains an unparseable colour ${JSON.stringify(g)}`);
          return;
        }
        stops.push(c);
      }
      item.gradient = stops;
      const min = clampString(entry.minLabel, MAX_TITLE_LEN);
      const max = clampString(entry.maxLabel, MAX_TITLE_LEN);
      if (min) item.minLabel = min;
      if (max) item.maxLabel = max;
    }
    if (item.color === undefined && item.gradient === undefined) {
      errors.push(`${at} needs a color or a gradient (an item with neither draws an invisible swatch)`);
      return;
    }
    if (entry.shape !== undefined) {
      if (entry.shape !== 'dot' && entry.shape !== 'line') {
        errors.push(`${at}.shape must be 'dot' or 'line', got ${JSON.stringify(entry.shape)}`);
        return;
      }
      item.shape = entry.shape;
    }
    out.push(item);
  });
  return out.length ? out : undefined;
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
  // Rejected rather than ignored. A spec declaring a version this build does not
  // implement is the one case where rendering anyway is worse than refusing: the
  // fields it relies on would be silently dropped and the map would draw a
  // partial picture that still looks like an answer.
  if (body.version !== undefined) {
    const v = Number(body.version);
    if (!Number.isInteger(v) || v < 1) {
      errors.push(`version must be a positive integer, got ${JSON.stringify(body.version)}`);
    } else if (v > MAP_SPEC_VERSION) {
      errors.push(
        `map spec version ${v} is newer than this build supports (${MAP_SPEC_VERSION})`,
      );
    }
  }
  for (const k of INTERACTIVE_KEYS) {
    if (body[k] !== undefined) {
      errors.push(`config.${k} is not supported on an inline map (a chat message has no view state)`);
    }
  }
  const layers = validateMapLayers(body.layers, errors, { allowViewState: false });
  // Validated BEFORE the early return below, so a bad legend is reported by name
  // alongside any layer errors instead of being cast through unchecked.
  const legend = validateLegend(body.legend, 'legend', errors);
  const categoryLegend = validateLegend(body.categoryLegend, 'categoryLegend', errors);
  if (errors.length > 0) return { ok: false, errors };

  let height = DEFAULT_MAP_HEIGHT;
  if (body.height !== undefined) {
    const h = Number(body.height);
    if (Number.isFinite(h)) height = Math.min(MAX_MAP_HEIGHT, Math.max(MIN_MAP_HEIGHT, Math.round(h)));
  }

  return {
    ok: true,
    spec: {
      version: body.version === undefined ? MAP_SPEC_VERSION : Number(body.version),
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

// What a declarative view reads: every <DB>.<SCHEMA>.<OBJECT> reference in every
// nested `data.query` (top-level areas, map layers, filter option queries).
//
// Used by /api/pack-status (what to probe) and load-views (what a view needs).
// Both used to scan only `areas[*].data.query`, so a view whose layer or filter
// query read a missing schema was never gated. scripts/layer_impact.py walks
// the same way for the installer and the agent catalog; check_view_availability
// asserts the two agree on every shipped view.

export interface DataRef {
  schema: string;
  object: string;
  /** Followed by '(' - a UDTF/function, which cannot be probed with SELECT. */
  isFunction: boolean;
}

export function collectQueries(node: unknown, out: string[] = []): string[] {
  if (Array.isArray(node)) {
    for (const v of node) collectQueries(v, out);
  } else if (node && typeof node === 'object') {
    const o = node as Record<string, unknown>;
    const data = o.data as { query?: unknown } | undefined;
    if (data && typeof data === 'object' && typeof data.query === 'string') out.push(data.query);
    for (const v of Object.values(o)) collectQueries(v, out);
  }
  return out;
}

export function dataRefs(sql: string, db: string): DataRef[] {
  const re = new RegExp(`\\b${db}\\.([A-Za-z0-9_]+)\\.([A-Za-z0-9_]+)`, 'g');
  const out: DataRef[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(sql)) !== null) {
    const rest = sql.slice(m.index + m[0].length);
    out.push({ schema: m[1].toUpperCase(), object: m[2].toUpperCase(), isFunction: /^\s*\(/.test(rest) });
  }
  return out;
}

export function viewDataRefs(view: unknown, db: string): DataRef[] {
  const seen = new Map<string, DataRef>();
  for (const q of collectQueries(view)) {
    for (const r of dataRefs(q, db)) {
      const k = `${r.schema}.${r.object}`;
      const prev = seen.get(k);
      // A name used as a function anywhere is a function.
      seen.set(k, prev ? { ...prev, isFunction: prev.isFunction || r.isFunction } : r);
    }
  }
  return [...seen.values()];
}

export function viewSchemas(view: unknown, db: string): Set<string> {
  return new Set(viewDataRefs(view, db).map((r) => r.schema));
}

// Per-schema availability from /api/pack-status.
//   present    - the probe object returned rows (or the function exists)
//   absent     - the object does not exist, the role cannot read it, or the
//                builder left it empty: the layer was not built
//   unverified - the probe could not complete (timeout, busy warehouse), so
//                nothing is known; the view stays usable
export type LayerState = 'present' | 'absent' | 'unverified';
export interface LayerStatus {
  state: LayerState;
  object: string;
  label?: string;
  fix?: string[];
  note?: string;
}

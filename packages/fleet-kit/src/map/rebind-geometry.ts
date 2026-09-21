// Rescue a map layer whose geometry encoding names a column the result does not
// actually contain, by rebinding it to a real geometry column in the same result.
//
// WHY THIS EXISTS, and why it is not the more obvious thing.
//
// A layer with NO geometry encoding is already rejected before any query runs:
// validateMapLayers -> missingEncodings raises INVALID_MAP_SPEC_ENCODING. So a
// "fill in the missing encoding" fallback at fetch time would be unreachable
// code. The failure that IS reachable is the opposite one: the encoding is
// present and well-formed, but names a column that is not in the rows.
// Validation only checks that the field EXISTS, never that it resolves against
// the data, and the compiler filters rows with `has(row, column)` - so an
// unresolvable name removes every row and the layer renders as an empty basemap
// with no exception, no message, and a legend that can still look populated.
//
// This repo has already shipped that bug twice: a render_map spec using an
// UPPERCASE hexColumn (every row key is lowercased by /api/query) drew nothing
// over perfectly good data, and the same class recurred across the other
// components. Case is the common cause, but a stale column name after a view
// rename fails identically.
//
// Detection SUGGESTS, it does not override: a layer whose column resolves is
// never touched, and the layer TYPE is never changed. If the result's geometry
// is a different representation than the layer asked for (a GEOGRAPHY column
// where the layer wants lng/lat numerics), nothing is rebound - drawing a
// different geometry than the spec requested would be a wrong map rather than an
// empty one, which is worse.

import { detectGeoColumns, type DetectColumn } from './detect-geo';
import type { LayerSpec } from './layer-spec';

export interface RebindNote {
  /** Encoding field that was rebound, e.g. 'hexColumn' or 'lng/lat'. */
  field: string;
  /** The unresolvable column name the spec asked for. */
  from: string;
  /** The column actually bound. */
  to: string;
  /** Why detection believes `to` is geometry (from detectGeoColumns). */
  reason: string;
}

export interface RebindResult {
  layer: LayerSpec;
  note?: RebindNote;
}

type Row = Record<string, unknown>;

/** True when `name` is a key on any sampled row. Mirrors the compiler's own
 *  `has(row, column)` test, which is what silently drops the rows. */
function resolves(name: string | undefined, rows: Row[]): boolean {
  if (!name) return false;
  return rows.some((r) => r != null && Object.prototype.hasOwnProperty.call(r, name));
}

/**
 * Rebind `layer`'s geometry encoding when it names a column absent from `rows`.
 *
 * `columns` carries the DECLARED Snowflake type per column, which is what makes
 * a GEOGRAPHY column bindable with no value sniffing at all (and is the only
 * signal that survives a result with rows the sample does not reach).
 *
 * Returns the layer unchanged, with no note, whenever there is nothing to fix or
 * nothing safe to fix it with.
 */
export function rebindLayerGeometry(
  layer: LayerSpec,
  columns: Array<{ key: string; label?: string; type?: string }> | undefined,
  rows: Row[] | undefined,
): RebindResult {
  const sample = rows ?? [];
  if (!sample.length || !columns?.length) return { layer };

  // Probe against the ROW KEY, since that is what the compiler indexes with.
  const probe: DetectColumn[] = columns.map((c) => ({ name: c.key, type: c.type ?? '' }));

  switch (layer.type) {
    case 'geojson':
    case 'path': {
      // `path` has two legal shapes. Only the geojsonColumn shape is rescued
      // here: a start+end pair that does not resolve needs two numeric columns
      // detection reports as one scatterplot binding, and silently turning a
      // two-point path into something else is not a like-for-like repair.
      const declared = layer.geojsonColumn;
      if (layer.type === 'path' && !declared) return { layer };
      if (resolves(declared, sample)) return { layer };
      const det = detectGeoColumns(probe, sample);
      if (det?.type !== 'geojson' || !det.geojsonColumn) return { layer };
      return {
        layer: { ...layer, geojsonColumn: det.geojsonColumn },
        note: { field: 'geojsonColumn', from: declared ?? '(unset)', to: det.geojsonColumn, reason: det.reason },
      };
    }
    case 'h3': {
      if (resolves(layer.hexColumn, sample)) return { layer };
      const det = detectGeoColumns(probe, sample);
      if (det?.type !== 'h3' || !det.hexColumn) return { layer };
      return {
        layer: { ...layer, hexColumn: det.hexColumn },
        note: { field: 'hexColumn', from: layer.hexColumn ?? '(unset)', to: det.hexColumn, reason: det.reason },
      };
    }
    case 'scatterplot': {
      if (resolves(layer.lng, sample) && resolves(layer.lat, sample)) return { layer };
      const det = detectGeoColumns(probe, sample);
      if (det?.type !== 'scatterplot' || !det.lng || !det.lat) return { layer };
      return {
        layer: { ...layer, lng: det.lng, lat: det.lat },
        note: {
          field: 'lng/lat',
          from: `${layer.lng ?? '(unset)'}/${layer.lat ?? '(unset)'}`,
          to: `${det.lng}/${det.lat}`,
          reason: det.reason,
        },
      };
    }
    default:
      // arc needs a source AND target pair; detection reports a single point
      // binding, so there is no unambiguous repair. Left alone on purpose.
      return { layer };
  }
}

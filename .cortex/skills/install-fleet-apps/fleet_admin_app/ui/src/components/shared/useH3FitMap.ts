'use client';
import { useMemo } from 'react';
import { coordsFromH3Cells, type LngLat } from './mapFit';
import { useFitMap, type UseFitMapOptions, type UseFitMapResult } from './useFitMap';

export interface UseH3FitMapOptions extends UseFitMapOptions {
  /**
   * Optional extra LngLat points to merge into the fit bounds (e.g. origin/dest
   * markers for a map that mixes hex layers with point layers).
   */
  extraCoords?: LngLat[] | null;
  /**
   * Maximum number of hex rows whose vertices are used to compute the fit
   * bounds. Larger sets are strided. Defaults to 2000.
   */
  sample?: number;
}

/**
 * Like `useFitMap`, but accepts rows backed by H3 cell strings. Builds the
 * bounding box from each hex's polygon vertices (via `cellToBoundary`), so the
 * camera fits the full hex footprint instead of just hex centers - fixing the
 * outer-hex cropping that occurs at low H3 resolutions.
 */
export function useH3FitMap<T>(
  rows: T[] | null | undefined,
  getCell: (row: T) => string | null | undefined,
  options: UseH3FitMapOptions = {}
): UseH3FitMapResult {
  const { extraCoords, sample, ...fitOptions } = options;
  const fitCoords = useMemo<LngLat[]>(() => {
    const hexCoords = coordsFromH3Cells(rows, getCell, { sample: sample ?? 2000 });
    if (!extraCoords || !extraCoords.length) return hexCoords;
    return hexCoords.concat(extraCoords);
  }, [rows, getCell, extraCoords, sample]);
  const result = useFitMap(fitCoords, fitOptions);
  return { ...result, fitCoords };
}

export interface UseH3FitMapResult extends UseFitMapResult {
  fitCoords: LngLat[];
}

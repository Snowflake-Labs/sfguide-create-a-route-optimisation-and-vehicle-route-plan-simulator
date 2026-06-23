'use client';
import { useRegion } from './useRegion';
import { useVehicleType } from './useVehicleType';

export interface ActivePreset {
  region: string;
  regionDisplay: string;
  center: { lat: number; lng: number };
  boundaryGeoJson: string | null;
  vehicleType: string;
  orsProfile: string;
  activeDatasetId: string | null;
  loading: boolean;
  refresh: () => Promise<void>;
}

/** Active dataset preset: region + vehicle type + ORS profile from header DatasetPicker. */
export function useActivePreset(): ActivePreset {
  const region = useRegion();
  const vt = useVehicleType();

  return {
    region: region.regionName,
    regionDisplay: region.displayName,
    center: region.center,
    boundaryGeoJson: region.boundaryGeoJson,
    vehicleType: vt.vehicleType,
    orsProfile: vt.orsProfile,
    activeDatasetId: vt.activeDatasetId,
    loading: region.loading || vt.loading,
    refresh: async () => {
      await Promise.all([region.refresh(), vt.refresh()]);
    },
  };
}

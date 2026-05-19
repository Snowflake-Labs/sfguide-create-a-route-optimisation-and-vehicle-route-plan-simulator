import { useState, useEffect, useCallback, createContext, useContext } from 'react';

export interface DatasetPair { vehicleType: string; region: string; }

interface VehicleTypeContextValue {
  vehicleType: string;
  availableTypes: string[];
  datasetPairs: DatasetPair[];
  loading: boolean;
  switchVehicleType: (type: string) => Promise<void>;
  regionsForType: (type: string) => string[];
  typesForRegion: (region: string) => string[];
  refresh: () => Promise<void>;
}

const defaults: VehicleTypeContextValue = {
  vehicleType: 'ebike',
  availableTypes: [],
  datasetPairs: [],
  loading: true,
  switchVehicleType: async () => {},
  regionsForType: () => [],
  typesForRegion: () => [],
  refresh: async () => {},
};

const VehicleTypeContext = createContext<VehicleTypeContextValue>(defaults);

export function useVehicleType() {
  return useContext(VehicleTypeContext);
}

export function useVehicleTypeProvider() {
  const [vehicleType, setVehicleType] = useState(defaults.vehicleType);
  const [availableTypes, setAvailableTypes] = useState<string[]>([]);
  const [datasetPairs, setDatasetPairs] = useState<DatasetPair[]>([]);
  const [loading, setLoading] = useState(true);

  const fetchConfig = useCallback(async () => {
    try {
      const res = await fetch('/api/fleet-config');
      if (res.ok) {
        const data = await res.json();
        if (data.vehicleType) setVehicleType(data.vehicleType);
        if (data.availableTypes) setAvailableTypes(data.availableTypes);
        if (data.datasetPairs) setDatasetPairs(data.datasetPairs);
      }
    } catch {
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { fetchConfig(); }, [fetchConfig]);

  const switchVehicleType = useCallback(async (type: string) => {
    try {
      await fetch('/api/fleet-config/vehicle-type', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ vehicleType: type }),
      });
      setVehicleType(type);
    } catch {}
  }, []);

  const regionsForType = useCallback((type: string) => {
    return [...new Set(datasetPairs.filter(p => p.vehicleType === type).map(p => p.region))];
  }, [datasetPairs]);

  const typesForRegion = useCallback((region: string) => {
    return [...new Set(datasetPairs.filter(p => p.region === region).map(p => p.vehicleType))];
  }, [datasetPairs]);

  const value: VehicleTypeContextValue = {
    vehicleType,
    availableTypes,
    datasetPairs,
    loading,
    switchVehicleType,
    regionsForType,
    typesForRegion,
    refresh: fetchConfig,
  };

  return { value, VehicleTypeContext };
}

export { VehicleTypeContext };

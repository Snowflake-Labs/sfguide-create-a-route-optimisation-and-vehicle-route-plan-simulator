import { useState, useEffect, useCallback, createContext, useContext } from 'react';

interface VehicleTypeContextValue {
  vehicleType: string;
  availableTypes: string[];
  loading: boolean;
  switchVehicleType: (type: string) => Promise<void>;
}

const defaults: VehicleTypeContextValue = {
  vehicleType: 'hgv',
  availableTypes: [],
  loading: true,
  switchVehicleType: async () => {},
};

const VehicleTypeContext = createContext<VehicleTypeContextValue>(defaults);

export function useVehicleType() {
  return useContext(VehicleTypeContext);
}

export function useVehicleTypeProvider() {
  const [vehicleType, setVehicleType] = useState(defaults.vehicleType);
  const [availableTypes, setAvailableTypes] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);

  const fetchConfig = useCallback(async () => {
    try {
      const res = await fetch('/api/fleet-config');
      if (res.ok) {
        const data = await res.json();
        if (data.vehicleType) setVehicleType(data.vehicleType);
        if (data.availableTypes) setAvailableTypes(data.availableTypes);
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

  const value: VehicleTypeContextValue = {
    vehicleType,
    availableTypes,
    loading,
    switchVehicleType,
  };

  return { value, VehicleTypeContext };
}

export { VehicleTypeContext };

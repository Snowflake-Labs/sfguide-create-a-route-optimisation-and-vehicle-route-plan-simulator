import { useAppStore } from '@/lib/store';
import { useShallow } from 'zustand/react/shallow';
import type { PanelContext } from '@/lib/types';

export function usePanelContext(): PanelContext {
  return useAppStore(useShallow((s) => s.getPanelContext()));
}

import { useAppStore } from '@/lib/store';

export function usePanel() {
  const activeViewId = useAppStore((s) => s.panel.activeViewId);
  const viewState = useAppStore((s) => s.panel.viewState);
  const hasUnsavedChanges = useAppStore((s) => s.panel.hasUnsavedChanges);
  const showView = useAppStore((s) => s.showView);
  const updateViewState = useAppStore((s) => s.updateViewState);
  const setDirty = useAppStore((s) => s.setDirty);

  return { activeViewId, viewState, hasUnsavedChanges, showView, updateViewState, setDirty };
}

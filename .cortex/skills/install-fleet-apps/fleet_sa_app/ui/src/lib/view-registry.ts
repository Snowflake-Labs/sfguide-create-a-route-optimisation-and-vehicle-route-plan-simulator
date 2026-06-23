import type { ViewDef } from './types';
import { canRoleSeeView, type AppRole } from './roles';

class ViewRegistry {
  private views = new Map<string, ViewDef>();

  register(def: ViewDef): void {
    this.views.set(def.id, def);
  }

  get(id: string): ViewDef | undefined {
    return this.views.get(id);
  }

  search(query: string, role?: AppRole): ViewDef[] {
    const q = query.toLowerCase();
    return this.list(role).filter(
      (v) =>
        v.label.toLowerCase().includes(q) ||
        v.description.toLowerCase().includes(q) ||
        v.tags?.some((t) => t.toLowerCase().includes(q)),
    );
  }

  // Lists non-hidden views. When `role` is provided, also filters to views the
  // selected role is allowed to see (simulated client-side role filter).
  list(role?: AppRole): ViewDef[] {
    return Array.from(this.views.values()).filter(
      (v) => !v.hidden && (role === undefined || canRoleSeeView(role, v)),
    );
  }
}

export const viewRegistry = new ViewRegistry();

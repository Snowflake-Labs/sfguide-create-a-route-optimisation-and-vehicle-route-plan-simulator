import type { ViewDef } from './types';

class ViewRegistry {
  private views = new Map<string, ViewDef>();

  register(def: ViewDef): void {
    this.views.set(def.id, def);
  }

  get(id: string): ViewDef | undefined {
    return this.views.get(id);
  }

  search(query: string): ViewDef[] {
    const q = query.toLowerCase();
    return this.list().filter(
      (v) =>
        v.label.toLowerCase().includes(q) ||
        v.description.toLowerCase().includes(q) ||
        v.tags?.some((t) => t.toLowerCase().includes(q)),
    );
  }

  list(): ViewDef[] {
    return Array.from(this.views.values()).filter((v) => !v.hidden);
  }
}

export const viewRegistry = new ViewRegistry();

import type { InlineComponentDef } from './types';

class InlineComponentRegistry {
  private components = new Map<string, InlineComponentDef>();

  register(def: InlineComponentDef): void {
    this.components.set(def.toolName, def);
  }

  get(toolName: string): InlineComponentDef | undefined {
    return this.components.get(toolName);
  }

  list(): InlineComponentDef[] {
    return Array.from(this.components.values());
  }
}

export const inlineRegistry = new InlineComponentRegistry();

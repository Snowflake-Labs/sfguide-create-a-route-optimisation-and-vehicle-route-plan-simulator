import type { InlineComponentDef } from './types';

class InlineComponentRegistry {
  private components = new Map<string, InlineComponentDef>();

  register(def: InlineComponentDef): void {
    this.components.set(def.toolName, def);
  }

  /**
   * Resolve a component for a streamed tool name.
   *
   * An MCP tool arrives from Cortex namespaced by its server
   * (`routing_mcp__render_map`), while registrations are by BARE verb name -
   * which is exactly why store.ts has to match `endsWith('__render_view')`. An
   * exact-only lookup therefore falls through to the raw JSON viewer for every
   * namespaced verb, silently, since an unregistered tool is a legal state.
   * Fall back to the segment after the last `__`.
   */
  get(toolName: string): InlineComponentDef | undefined {
    const exact = this.components.get(toolName);
    if (exact) return exact;
    const sep = toolName.lastIndexOf('__');
    if (sep === -1) return undefined;
    return this.components.get(toolName.slice(sep + 2));
  }

  list(): InlineComponentDef[] {
    return Array.from(this.components.values());
  }
}

export const inlineRegistry = new InlineComponentRegistry();

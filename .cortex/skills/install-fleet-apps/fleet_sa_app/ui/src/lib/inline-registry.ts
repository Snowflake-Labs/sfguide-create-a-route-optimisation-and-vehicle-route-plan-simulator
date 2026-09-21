import type { InlineComponentDef } from './types';
import { matchesTool } from './tool-names';

class InlineComponentRegistry {
  private components = new Map<string, InlineComponentDef>();

  register(def: InlineComponentDef): void {
    this.components.set(def.toolName, def);
  }

  /**
   * Resolve a component for a streamed tool name.
   *
   * An MCP tool arrives from Cortex namespaced by its server, and the observed
   * separator is a SINGLE underscore (`routing_mcp_render_map`) - see
   * lib/tool-names.ts for where that was measured. An exact-only lookup
   * therefore falls through to the raw JSON viewer for every namespaced verb,
   * silently, since an unregistered tool is a legal state.
   *
   * Registrations are by BARE verb name, so the fallback scans them and takes
   * the first suffix match. Longest name first, so a hypothetical pair like
   * `render_map` / `map` cannot resolve to the shorter one by iteration order.
   */
  get(toolName: string): InlineComponentDef | undefined {
    const exact = this.components.get(toolName);
    if (exact) return exact;
    const names = Array.from(this.components.keys()).sort((a, b) => b.length - a.length);
    for (const bare of names) {
      if (matchesTool(toolName, bare)) return this.components.get(bare);
    }
    return undefined;
  }

  list(): InlineComponentDef[] {
    return Array.from(this.components.values());
  }
}

export const inlineRegistry = new InlineComponentRegistry();

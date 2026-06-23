// Framework-level workflow registry.
// App builders call registerWorkflow() from their app-specific init file.
// Route handlers call getWorkflow() to look up registered definitions.

import type { WorkflowDefinition } from './engine';

const registry = new Map<string, WorkflowDefinition>();

export function registerWorkflow(def: WorkflowDefinition): void {
  registry.set(def.type, def);
}

export function getWorkflow(type: string): WorkflowDefinition | undefined {
  return registry.get(type);
}

export function listWorkflows(): WorkflowDefinition[] {
  return Array.from(registry.values());
}

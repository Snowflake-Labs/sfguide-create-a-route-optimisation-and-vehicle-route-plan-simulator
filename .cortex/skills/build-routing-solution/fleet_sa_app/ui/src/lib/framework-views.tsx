import { lazy } from 'react';
import { viewRegistry } from './view-registry';

// Always-on framework view: summarizes what the selected role can access
// (visible views, tools/verbs, contract/schema access). Visible to all roles.
export function registerRoleAccessView(): void {
  viewRegistry.register({
    id: 'role_access',
    label: 'Role Access',
    description: 'Evaluate what each role (User / Ops / Admin) can see and do. Pick a role in the header to compare.',
    category: 'Admin',
    component: lazy(() =>
      import('@/components/views/areas/role-access').then((mod) => ({
        default: mod.RoleAccessView,
      })),
    ),
  });
}

export function registerWorkflowViews(database: string, schema: string): void {
  viewRegistry.register({
    id: 'workflow_manager',
    label: 'Workflow Manager',
    description: 'All workflow runs. Filter and click a row to see details and take action on pending approvals.',
    component: lazy(() =>
      import('@/components/views/areas/workflow-manager').then((mod) => ({
        default: function WorkflowManagerView() {
          return <mod.WorkflowManagerArea database={database} schema={schema} />;
        },
      })),
    ),
  });

  viewRegistry.register({
    id: 'workflow_detail',
    label: 'Workflow Detail',
    description: 'Step-by-step progress and HITL approval panel for a single workflow instance.',
    hidden: true,
    component: lazy(() =>
      import('@/components/views/areas/workflow-detail').then((mod) => ({
        default: function WorkflowDetailView() {
          return <mod.WorkflowDetailArea database={database} schema={schema} />;
        },
      })),
    ),
  });
}

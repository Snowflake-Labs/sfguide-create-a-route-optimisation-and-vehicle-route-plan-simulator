import { lazy } from 'react';
import { viewRegistry } from './view-registry';

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

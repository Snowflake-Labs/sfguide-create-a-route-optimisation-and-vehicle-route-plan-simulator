// CDP app workflow registration.
// This is the ONLY file in ui/src/ that imports app-specific workflow definitions.
// When building a new app, replace the imports and registerWorkflow calls here.
//
// The framework route handlers (mcp, workflow/execute, workflow/resume)
// import this file as a side-effect to populate the registry at startup.

import { registerWorkflow } from './registry';
import { campaignSetupWorkflow } from './campaign-setup';
import { campaignExecutionWorkflow } from './campaign-execution';

registerWorkflow(campaignSetupWorkflow);
registerWorkflow(campaignExecutionWorkflow);

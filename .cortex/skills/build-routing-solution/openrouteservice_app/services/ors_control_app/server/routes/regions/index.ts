// Region router barrel — composes all sub-routers under one mount.

import { Router } from 'express';
import { createRegionsLifecycleRouter } from './lifecycle.js';

export function createRegionsRouter(): Router {
  const router = Router();
  router.use(createRegionsLifecycleRouter());
  // catalog, provision, progress sub-routers will be mounted here as they
  // get extracted from server/index.ts (Phase 1 ongoing).
  return router;
}

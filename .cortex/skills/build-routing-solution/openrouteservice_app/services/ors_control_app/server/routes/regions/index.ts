// Region router barrel — composes all sub-routers under one mount.

import { Router } from 'express';
import { createRegionsLifecycleRouter } from './lifecycle.js';
import { createRegionsManagementRouter } from './management.js';

export function createRegionsRouter(): Router {
  const router = Router();
  router.use(createRegionsLifecycleRouter());
  router.use(createRegionsManagementRouter());
  return router;
}

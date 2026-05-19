// Region router barrel — composes all sub-routers under one mount.

import { Router } from 'express';
import { createRegionsLifecycleRouter } from './lifecycle.js';
import { createRegionsCatalogRouter } from './catalog.js';
import { createRegionsRegistryRouter } from './registry.js';
import { createRegionsProvisioningRouter } from './provisioning.js';

export function createRegionsRouter(): Router {
  const router = Router();
  router.use(createRegionsLifecycleRouter());
  router.use(createRegionsCatalogRouter());
  router.use(createRegionsRegistryRouter());
  router.use(createRegionsProvisioningRouter());
  return router;
}

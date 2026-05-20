// Matrix router composition. Mounts build/status/query sub-routers under the
// existing /api/matrix prefix (no API surface change).

import { Router } from 'express';
import { createMatrixBuildRouter } from './build.js';
import { createMatrixStatusRouter } from './status.js';
import { createMatrixQueryRouter } from './query.js';

export function createMatrixRouter(): Router {
  const router = Router();
  router.use(createMatrixBuildRouter());
  router.use(createMatrixStatusRouter());
  router.use(createMatrixQueryRouter());
  return router;
}

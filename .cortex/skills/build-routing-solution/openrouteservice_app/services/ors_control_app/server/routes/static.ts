// SPA static file serving + catch-all route.

import { Router, static as expressStatic } from 'express';
import { join } from 'path';

export function createStaticRouter(distDir: string): Router {
  const router = Router();

  router.use('/assets', expressStatic(join(distDir, 'assets'), {
    maxAge: '1y',
    immutable: true,
  }));

  router.use(expressStatic(distDir, {
    etag: false,
    lastModified: false,
    setHeaders: (res, filePath) => {
      if (filePath.endsWith('.html')) {
        res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
        res.setHeader('Pragma', 'no-cache');
        res.setHeader('Expires', '0');
      }
    },
  }));

  router.get('*', (_req, res) => {
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
    res.sendFile(join(distDir, 'index.html'));
  });

  return router;
}

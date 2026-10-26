import { Router } from 'express';
import type { Pool } from '../db/pool.js';

export function healthRouter(pool: Pool): Router {
  const router = Router();

  // Liveness: the process is up and serving HTTP. Deliberately touches nothing else.
  router.get('/health', (_req, res) => {
    res.json({ status: 'ok' });
  });

  // Readiness: dependencies are reachable. Queue statistics are added with the worker (M4).
  router.get('/health/ready', async (_req, res) => {
    try {
      await pool.query('SELECT 1');
      res.json({ status: 'ok', db: 'ok' });
    } catch {
      res.status(503).json({ status: 'unavailable', db: 'unreachable' });
    }
  });

  return router;
}

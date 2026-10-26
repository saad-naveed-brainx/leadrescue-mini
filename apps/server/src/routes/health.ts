import { Router } from 'express';
import { db } from '../db.js';
import { queueStats } from '../services/jobs.js';

export const healthRouter = Router();

// "Is the server running?" Answers without touching anything else.
healthRouter.get('/health', (_req, res) => {
  res.json({ status: 'ok' });
});

// "Is the server ready to work?" Also checks that the database answers, and shows the job queue:
// waiting, being worked on, and dead (failed for good; a person should look at those).
healthRouter.get('/health/ready', async (_req, res) => {
  try {
    await db.query('SELECT 1');
  } catch {
    res.status(503).json({ status: 'unavailable', db: 'unreachable' });
    return;
  }
  // The database answers; report the queue separately, so a queue problem isn't shown as "db down".
  try {
    res.json({ status: 'ok', db: 'ok', queue: await queueStats() });
  } catch {
    res.status(503).json({ status: 'unavailable', db: 'ok', queue: 'unavailable' });
  }
});

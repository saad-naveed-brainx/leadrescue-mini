import { Router } from 'express';
import { db } from '../db.js';

export const healthRouter = Router();

// "Is the server running?" Answers without touching anything else.
healthRouter.get('/health', (_req, res) => {
  res.json({ status: 'ok' });
});

// "Is the server ready to work?" Also checks that the database answers.
healthRouter.get('/health/ready', async (_req, res) => {
  try {
    await db.query('SELECT 1');
    res.json({ status: 'ok', db: 'ok' });
  } catch {
    res.status(503).json({ status: 'unavailable', db: 'unreachable' });
  }
});

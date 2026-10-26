import express from 'express';
import { pinoHttp } from 'pino-http';
import type { Pool } from '../db/pool.js';
import { errorHandler, notFoundHandler } from './errors.js';
import { healthRouter } from './health.js';
import { logger } from './logger.js';
import { currentRequestId, requestIdMiddleware } from './requestContext.js';

export interface AppDeps {
  pool: Pool;
}

export function createApp({ pool }: AppDeps): express.Express {
  const app = express();
  app.disable('x-powered-by');

  app.use(requestIdMiddleware);
  app.use(
    pinoHttp({
      logger,
      genReqId: () => currentRequestId() ?? 'unknown',
      // Health probes would drown out real traffic.
      autoLogging: { ignore: (req) => req.url?.startsWith('/health') ?? false },
    }),
  );
  app.use(express.json({ limit: '100kb' }));

  app.use(healthRouter(pool));

  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}

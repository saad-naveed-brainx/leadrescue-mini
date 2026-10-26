import express from 'express';
import { pinoHttp } from 'pino-http';
import { devAuthRouter, meRouter } from '../auth/routes.js';
import { config } from '../config.js';
import type { Pool } from '../db/pool.js';
import { auditRouter } from '../modules/audit/routes.js';
import { leadsRouter } from '../modules/leads/routes.js';
import { webhooksRouter } from '../modules/webhooks/routes.js';
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
  // Only the local login exists today; a real identity provider would replace this router only.
  if (config.AUTH_MODE === 'local') app.use(devAuthRouter(pool));
  app.use(meRouter(pool));
  app.use(leadsRouter(pool));
  app.use(auditRouter(pool));
  app.use(webhooksRouter(pool));

  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}

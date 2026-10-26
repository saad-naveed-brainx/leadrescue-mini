import express from 'express';
import { errorHandler, notFoundHandler } from './middleware/errors.js';
import { requestId } from './middleware/requestId.js';
import { requestLogger } from './middleware/requestLogger.js';
import { auditRouter } from './routes/audit.js';
import { authRouter } from './routes/auth.js';
import { conversationsRouter } from './routes/conversations.js';
import { healthRouter } from './routes/health.js';
import { leadsRouter } from './routes/leads.js';
import { webhooksRouter } from './routes/webhooks.js';

// The Express app. Every request runs through these steps from top to bottom, so order matters.
export const app = express();
app.disable('x-powered-by'); // don't advertise which framework we run

// 1. Steps every request goes through.
app.use(requestId);
app.use(requestLogger);
app.use(express.json({ limit: '100kb' }));

// 2. The routes.
app.use(healthRouter);
app.use(authRouter);
app.use(leadsRouter);
app.use(conversationsRouter);
app.use(auditRouter);
app.use(webhooksRouter);

// 3. No route matched, or a route threw an error.
app.use(notFoundHandler);
app.use(errorHandler);

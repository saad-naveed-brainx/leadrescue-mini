import cors from 'cors';
import express from 'express';
import helmet from 'helmet';
import { config } from './config.js';
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
// Standard security headers (no MIME sniffing, no framing, HTTPS-only hint, and so on).
app.use(helmet());
// Only our own web app may read API answers in a browser. Other sites' pages get no CORS headers,
// so the browser blocks them. Server-to-server callers (Twilio, curl) send no Origin and are
// unaffected. Logins travel in the Authorization header, not cookies, so no credentials mode.
app.use(cors({ origin: [config.WEB_ORIGIN], methods: ['GET', 'POST', 'PATCH', 'DELETE'] }));
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

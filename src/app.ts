import express from 'express';
import { errorHandler, notFoundHandler } from './middleware/errors.js';
import { conversationsRouter } from './routes/conversations.js';
import { leadsRouter } from './routes/leads.js';
import { webhooksRouter } from './routes/webhooks.js';

// The Express app. Every request runs through these steps from top to bottom, so order matters.
export const app = express();
app.disable('x-powered-by'); // don't advertise which framework we run

// 1. Read JSON bodies (capped, so a huge body can't tie up the server).
app.use(express.json({ limit: '100kb' }));

// 2. The routes.
app.use(leadsRouter);
app.use(conversationsRouter);
app.use(webhooksRouter);

// 3. No route matched, or a route threw an error.
app.use(notFoundHandler);
app.use(errorHandler);

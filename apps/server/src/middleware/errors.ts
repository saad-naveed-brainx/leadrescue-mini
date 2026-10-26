import type { ErrorRequestHandler, Request, RequestHandler, Response } from 'express';
import { ZodError } from 'zod';
import { logger } from '../logger.js';

/** An error we expect and can safely show to the caller, with its HTTP status and a fixed code. */
export class AppError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public details?: unknown,
  ) {
    super(message);
  }
}

export function notFound(what = 'Resource') {
  return new AppError(404, 'NOT_FOUND', `${what} not found`);
}

// Every error response has the same shape: { error: { code, message, details, requestId } }.
function sendError(
  req: Request,
  res: Response,
  status: number,
  code: string,
  message: string,
  details?: unknown,
) {
  res.status(status).json({ error: { code, message, details, requestId: req.requestId } });
}

// Runs when no route matched the URL.
export const notFoundHandler: RequestHandler = (req, res) => {
  sendError(req, res, 404, 'NOT_FOUND', `No route for ${req.method} ${req.path}`);
};

// Runs whenever a route throws. Express recognises an error handler by its four arguments, so
// `_next` must stay even though it isn't used.
export const errorHandler: ErrorRequestHandler = (err, req, res, _next) => {
  // Errors we threw on purpose (not found, not allowed, ...).
  if (err instanceof AppError) {
    sendError(req, res, err.status, err.code, err.message, err.details);
    return;
  }
  // The request body or query failed validation.
  if (err instanceof ZodError) {
    const details = err.issues.map((i) => ({ path: i.path.join('.'), message: i.message }));
    sendError(req, res, 400, 'VALIDATION_FAILED', 'Request validation failed', details);
    return;
  }
  // Broken JSON, or a body over the size limit (raised by express.json()).
  if (err?.type === 'entity.parse.failed') {
    sendError(req, res, 400, 'INVALID_JSON', 'Request body is not valid JSON');
    return;
  }
  if (err?.type === 'entity.too.large') {
    sendError(req, res, 413, 'PAYLOAD_TOO_LARGE', 'Request body is too large');
    return;
  }
  // Anything else is a bug: log the details for us, but show the caller nothing internal.
  logger.error({ err, requestId: req.requestId }, 'unhandled error');
  sendError(req, res, 500, 'INTERNAL', 'Something went wrong');
};

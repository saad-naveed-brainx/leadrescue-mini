import type { ErrorRequestHandler, RequestHandler } from 'express';
import { ZodError } from 'zod';
import { logger } from './logger.js';
import { currentRequestId } from './requestContext.js';

/** An error that is safe to show to the caller: it carries its own status and stable code. */
export class AppError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
  }
}

export const notFound = (what = 'Resource') => new AppError(404, 'NOT_FOUND', `${what} not found`);

interface ErrorBody {
  error: { code: string; message: string; details?: unknown; requestId: string | undefined };
}

function body(code: string, message: string, details?: unknown): ErrorBody {
  return { error: { code, message, details, requestId: currentRequestId() } };
}

export const notFoundHandler: RequestHandler = (req, res) => {
  res.status(404).json(body('NOT_FOUND', `No route for ${req.method} ${req.path}`));
};

// Express recognizes error handlers by their four arguments, so `_next` must stay.
export const errorHandler: ErrorRequestHandler = (err, _req, res, _next) => {
  if (err instanceof AppError) {
    res.status(err.status).json(body(err.code, err.message, err.details));
    return;
  }
  if (err instanceof ZodError) {
    const details = err.issues.map((i) => ({ path: i.path.join('.'), message: i.message }));
    res.status(400).json(body('VALIDATION_FAILED', 'Request validation failed', details));
    return;
  }
  // Malformed JSON or an oversized body, raised by express.json().
  if (typeof err === 'object' && err !== null && 'type' in err) {
    if (err.type === 'entity.parse.failed') {
      res.status(400).json(body('INVALID_JSON', 'Request body is not valid JSON'));
      return;
    }
    if (err.type === 'entity.too.large') {
      res.status(413).json(body('PAYLOAD_TOO_LARGE', 'Request body is too large'));
      return;
    }
  }
  // Anything else is a bug: log it in full, but never leak internals to the caller.
  logger.error({ err }, 'unhandled error');
  res.status(500).json(body('INTERNAL', 'Something went wrong'));
};

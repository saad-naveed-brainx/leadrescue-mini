import { randomUUID } from 'node:crypto';
import type { RequestHandler } from 'express';

declare module 'express-serve-static-core' {
  interface Request {
    /** A unique id for this request. It appears in the logs and in error responses, so a problem
     *  a user reports can be found in the logs. */
    requestId: string;
  }
}

// Accept an id sent by the caller only if it looks like an id: no spaces or symbols that could
// mess up the logs.
const VALID_ID = /^[A-Za-z0-9._-]{8,64}$/;

export const requestId: RequestHandler = (req, res, next) => {
  const fromCaller = req.header('x-request-id');
  req.requestId = fromCaller && VALID_ID.test(fromCaller) ? fromCaller : randomUUID();
  res.setHeader('X-Request-Id', req.requestId);
  next();
};

import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import type { RequestHandler } from 'express';

export interface RequestContext {
  requestId: string;
}

export const requestContext = new AsyncLocalStorage<RequestContext>();

// Accept a caller-supplied id only if it looks like an id, so it can't be used to inject log content.
const VALID_REQUEST_ID = /^[A-Za-z0-9._-]{8,64}$/;

export const requestIdMiddleware: RequestHandler = (req, res, next) => {
  const incoming = req.header('x-request-id');
  const requestId = incoming && VALID_REQUEST_ID.test(incoming) ? incoming : randomUUID();
  res.setHeader('X-Request-Id', requestId);
  requestContext.run({ requestId }, next);
};

export function currentRequestId(): string | undefined {
  return requestContext.getStore()?.requestId;
}

import type { RequestHandler } from 'express';
import { logger } from '../logger.js';

// Logs one line per request: method, path, status code and how long it took. 'close' fires both
// when the response was sent and when the caller hung up early, so both get logged.
export const requestLogger: RequestHandler = (req, res, next) => {
  const startedAt = Date.now();
  const path = req.path; // without the query string, which can contain search text

  res.on('close', () => {
    // Health checks run every few seconds and would drown out real traffic.
    if (path.startsWith('/health')) return;
    logger.info(
      {
        requestId: req.requestId,
        method: req.method,
        path,
        status: res.statusCode,
        ms: Date.now() - startedAt,
        aborted: !res.writableFinished,
      },
      'request',
    );
  });
  next();
};

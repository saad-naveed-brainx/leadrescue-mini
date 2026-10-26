import { pino } from 'pino';
import { config } from '../config.js';
import { currentRequestId } from './requestContext.js';

export const logger = pino({
  level: config.NODE_ENV === 'test' ? 'silent' : config.LOG_LEVEL,
  // Every log line written while handling a request carries its correlation id.
  mixin() {
    const requestId = currentRequestId();
    return requestId ? { requestId } : {};
  },
  redact: {
    paths: [
      'req.headers.authorization',
      'req.headers.cookie',
      'req.headers["x-twilio-signature"]',
      '*.password',
      '*.token',
    ],
    censor: '[redacted]',
  },
});

export type Logger = typeof logger;

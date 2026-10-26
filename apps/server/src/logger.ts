import { pino } from 'pino';
import { config } from './config.js';

// Writes one JSON line per log message. Silent during tests so test output stays readable.
// Rule: log ids only, never phone numbers, message text or tokens.
export const logger = pino({ level: config.NODE_ENV === 'test' ? 'silent' : config.LOG_LEVEL });

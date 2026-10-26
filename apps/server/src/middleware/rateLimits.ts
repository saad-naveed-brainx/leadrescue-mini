import { rateLimit } from 'express-rate-limit';
import { config } from '../config.js';
import { AppError } from './errors.js';

// Caps how many requests one IP address may make per minute to the two routes anyone can call
// without logging in. Counts are kept in this process's memory: fine for our single API process,
// but several API processes would each count separately (they would need a shared store).
function perMinute(limit: number) {
  return rateLimit({
    windowMs: 60_000,
    limit,
    standardHeaders: 'draft-7', // tells the caller its limit and when it resets
    legacyHeaders: false,
    // Answer with our usual JSON error shape instead of the library's plain text.
    handler: (_req, _res, next) => {
      next(new AppError(429, 'RATE_LIMITED', 'Too many requests; try again in a minute'));
    },
  });
}

// Sign-in: stops someone hammering the login to guess user ids.
export const loginRateLimit = perMinute(config.RATE_LIMIT_LOGIN_PER_MINUTE);

// Twilio webhooks: stops a flood of fake webhooks from tying up the server. It runs before the
// signature check, so even unsigned junk is counted and turned away cheaply.
export const webhookRateLimit = perMinute(config.RATE_LIMIT_WEBHOOK_PER_MINUTE);

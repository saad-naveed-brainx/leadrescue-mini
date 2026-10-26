import { fileURLToPath } from 'node:url';

// All settings come from environment variables. Locally they are read from the .env file in the
// repo root. Docker and the tests set them directly, so .env is skipped there.
if (process.env.NODE_ENV !== 'test') {
  try {
    process.loadEnvFile(fileURLToPath(new URL('../../../.env', import.meta.url)));
  } catch {
    // No .env file: use the environment as it is.
  }
}

function isPositiveWholeNumber(n: number): boolean {
  return Number.isInteger(n) && n > 0;
}

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing setting ${name}. Add it to .env (see .env.example).`);
  return value;
}

export const config = {
  NODE_ENV: process.env.NODE_ENV ?? 'development',
  LOG_LEVEL: process.env.LOG_LEVEL ?? 'info',
  API_PORT: Number(process.env.API_PORT ?? 4000),
  DATABASE_URL: required('DATABASE_URL'),

  // Signs login tokens. Anyone who knows it could sign in as anyone, so it must be long and secret.
  AUTH_JWT_SECRET: required('AUTH_JWT_SECRET'),
  AUTH_TOKEN_TTL_SECONDS: Number(process.env.AUTH_TOKEN_TTL_SECONDS ?? 8 * 60 * 60),

  // Used to check that incoming webhooks really come from Twilio.
  TWILIO_AUTH_TOKEN: required('TWILIO_AUTH_TOKEN'),
  // The public address Twilio calls. Twilio's signature covers the full URL, so we rebuild it from
  // this setting (never from the request's Host header, which a caller could fake).
  PUBLIC_BASE_URL: (process.env.PUBLIC_BASE_URL ?? 'http://localhost:4000').replace(/\/+$/, ''),

  // How long after an AI reply to send the one "just checking in" text if the customer stays
  // quiet. 24 hours normally; set it to 30 in .env to watch it happen in a demo.
  FOLLOW_UP_DELAY_SECONDS: Number(process.env.FOLLOW_UP_DELAY_SECONDS ?? 24 * 60 * 60),

  // How long a worker may hold a job before others assume it crashed and take it over.
  WORKER_LEASE_SECONDS: Number(process.env.WORKER_LEASE_SECONDS ?? 60),
};

// Refuse to start with settings that are unsafe or that would only fail later.
if (!['development', 'test', 'production'].includes(config.NODE_ENV)) {
  // A typo like "prod" must not slip past the production check below.
  throw new Error('NODE_ENV must be development, test or production');
}
if (!URL.canParse(config.DATABASE_URL) || !URL.canParse(config.PUBLIC_BASE_URL)) {
  throw new Error('DATABASE_URL and PUBLIC_BASE_URL must be full URLs');
}
if (config.AUTH_JWT_SECRET.length < 32) {
  throw new Error('AUTH_JWT_SECRET must be at least 32 characters');
}
if (config.TWILIO_AUTH_TOKEN.length < 16) {
  throw new Error('TWILIO_AUTH_TOKEN must be at least 16 characters');
}
if (
  !isPositiveWholeNumber(config.API_PORT) ||
  !isPositiveWholeNumber(config.AUTH_TOKEN_TTL_SECONDS) ||
  !isPositiveWholeNumber(config.FOLLOW_UP_DELAY_SECONDS) ||
  !isPositiveWholeNumber(config.WORKER_LEASE_SECONDS)
) {
  throw new Error(
    'API_PORT, AUTH_TOKEN_TTL_SECONDS, FOLLOW_UP_DELAY_SECONDS and WORKER_LEASE_SECONDS must be whole numbers above 0',
  );
}
// The only sign-in today is the dev login, where anyone can pick any user. Never in production.
if (config.NODE_ENV === 'production') {
  throw new Error('The dev login must not run in production');
}

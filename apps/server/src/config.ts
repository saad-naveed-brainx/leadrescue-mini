import { fileURLToPath } from 'node:url';
import { z } from 'zod';

// Load the repo-root .env when present (local dev). Docker sets the environment directly,
// and the test runner sets its own values, so .env must not override them.
if (process.env.NODE_ENV !== 'test') {
  try {
    process.loadEnvFile(fileURLToPath(new URL('../../../.env', import.meta.url)));
  } catch {
    // no .env file: rely on the real environment
  }
}

const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  API_PORT: z.coerce.number().int().positive().default(4000),
  DATABASE_URL: z.url(),
  // 'local' = the documented test-identity login (see auth/localJwt.ts). The only mode for now.
  AUTH_MODE: z.enum(['local']).default('local'),
  AUTH_JWT_SECRET: z.string().min(32, 'must be at least 32 characters'),
  AUTH_TOKEN_TTL_SECONDS: z.coerce
    .number()
    .int()
    .positive()
    .default(8 * 3600),
  // Verifies that inbound webhooks were signed by Twilio. Any value works with the mock; a real
  // deployment uses the Twilio account's auth token.
  TWILIO_AUTH_TOKEN: z.string().min(16, 'must be at least 16 characters'),
  // The address Twilio calls, exactly as configured in Twilio. Signatures cover the full URL, and
  // behind a proxy the Host header can't be trusted to rebuild it.
  PUBLIC_BASE_URL: z
    .url()
    .default('http://localhost:4000')
    .transform((u) => u.replace(/\/+$/, '')),
});

export type Config = z.infer<typeof EnvSchema>;

function loadConfig(): Config {
  const parsed = EnvSchema.safeParse(process.env);
  if (!parsed.success) {
    // Print which variables are wrong, never their values (they may be secrets).
    const problems = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`);
    throw new Error(`Invalid environment configuration:\n  ${problems.join('\n  ')}`);
  }
  // The test-identity login lets anyone pick any seeded user: never acceptable in production.
  if (parsed.data.NODE_ENV === 'production' && parsed.data.AUTH_MODE === 'local') {
    throw new Error('AUTH_MODE=local is a development login and must not run in production');
  }
  return parsed.data;
}

export const config = loadConfig();

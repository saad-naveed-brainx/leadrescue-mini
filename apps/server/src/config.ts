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
  DATABASE_URL: z.string().url(),
  // 'local' = the documented test-identity login (see auth/localJwt.ts). The only mode for now.
  AUTH_MODE: z.enum(['local']).default('local'),
  AUTH_JWT_SECRET: z.string().min(32, 'must be at least 32 characters'),
  AUTH_TOKEN_TTL_SECONDS: z.coerce
    .number()
    .int()
    .positive()
    .default(8 * 3600),
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

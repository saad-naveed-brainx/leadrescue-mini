import { fileURLToPath } from 'node:url';

// All settings come from environment variables. Locally they are read from the .env file in the
// project root. The tests set them in vitest.config.ts, so .env is skipped there.
if (process.env.NODE_ENV !== 'test') {
  try {
    process.loadEnvFile(fileURLToPath(new URL('../.env', import.meta.url)));
  } catch {
    // No .env file: use the environment as it is.
  }
}

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) throw new Error('Missing DATABASE_URL. Copy .env.example to .env.');

const PORT = Number(process.env.PORT ?? 4000);
if (!Number.isInteger(PORT) || PORT <= 0) throw new Error('PORT must be a whole number above 0');

export const config = { DATABASE_URL, PORT };

import { fileURLToPath } from 'node:url';

// Tests run against the separate leadrescue_test database, never the dev database.
try {
  process.loadEnvFile(fileURLToPath(new URL('../.env', import.meta.url)));
} catch {
  // CI provides TEST_DATABASE_URL directly
}

export const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ??
  'postgres://leadrescue:leadrescue_local_only@localhost:55432/leadrescue_test';

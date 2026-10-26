import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

// Tests run against the separate leadrescue_test database, never the dev database.
try {
  process.loadEnvFile(fileURLToPath(new URL('../../.env', import.meta.url)));
} catch {
  // CI provides TEST_DATABASE_URL directly
}
const testDatabaseUrl =
  process.env.TEST_DATABASE_URL ??
  'postgres://leadrescue:leadrescue_local_only@localhost:55432/leadrescue_test';

export default defineConfig({
  test: {
    env: { NODE_ENV: 'test', DATABASE_URL: testDatabaseUrl },
    // Test files share one database, so they run one at a time.
    fileParallelism: false,
    testTimeout: 15_000,
  },
});

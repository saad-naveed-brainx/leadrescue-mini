import { defineConfig } from 'vitest/config';
import { TEST_DATABASE_URL } from './test/testDatabaseUrl.js';

export default defineConfig({
  test: {
    env: {
      NODE_ENV: 'test',
      DATABASE_URL: TEST_DATABASE_URL,
      // Test-only signing key; tokens signed with it are worthless outside the test run.
      AUTH_JWT_SECRET: 'test-only-secret-not-used-anywhere-else-0000',
    },
    globalSetup: ['./test/globalSetup.ts'],
    // Test files share one database, so they run one at a time.
    fileParallelism: false,
    testTimeout: 15_000,
  },
});

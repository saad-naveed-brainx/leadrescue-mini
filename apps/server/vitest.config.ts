import { defineConfig } from 'vitest/config';
import { TEST_DATABASE_URL } from './test/testDatabaseUrl.js';

export default defineConfig({
  test: {
    env: { NODE_ENV: 'test', DATABASE_URL: TEST_DATABASE_URL },
    globalSetup: ['./test/globalSetup.ts'],
    // Test files share one database, so they run one at a time.
    fileParallelism: false,
    testTimeout: 15_000,
  },
});

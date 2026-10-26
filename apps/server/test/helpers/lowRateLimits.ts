// Imported first by rate-limits.test.ts. Imports run in order before the file's own code, and
// config.ts reads these when it is first loaded, so they must be set before anything imports it.
// Each test file gets its own fresh copy of the modules, so other files keep the high test limits.
process.env.RATE_LIMIT_LOGIN_PER_MINUTE = '3';
process.env.RATE_LIMIT_WEBHOOK_PER_MINUTE = '3';

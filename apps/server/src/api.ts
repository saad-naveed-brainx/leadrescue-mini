import { config } from './config.js';
import { createPool } from './db/pool.js';
import { createApp } from './http/app.js';
import { logger } from './http/logger.js';

const pool = createPool(config.DATABASE_URL);
const app = createApp({ pool });

const server = app.listen(config.API_PORT, () => {
  logger.info({ port: config.API_PORT }, 'api listening');
});

// Connections still open after this long are cut so a stuck request can't block shutdown forever.
const SHUTDOWN_TIMEOUT_MS = 10_000;
let shuttingDown = false;

async function shutdown(signal: string) {
  // A second signal (e.g. Ctrl-C during a slow drain) must not start a second shutdown.
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info({ signal }, 'api shutting down');

  const forceTimer = setTimeout(() => server.closeAllConnections(), SHUTDOWN_TIMEOUT_MS);
  // Stop accepting requests and wait for in-flight ones to finish before closing the pool they use.
  await new Promise<void>((resolve) => server.close(() => resolve()));
  clearTimeout(forceTimer);
  await pool.end();
  process.exit(0);
}
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));

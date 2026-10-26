import { app } from './app.js';
import { config } from './config.js';
import { db } from './db.js';
import { logger } from './logger.js';

// Starts the API: `npm run dev:api`.
const server = app.listen(config.API_PORT, () => {
  logger.info(`API listening on http://localhost:${config.API_PORT}`);
});

// Clean shutdown (Ctrl-C, or Docker stopping the container): stop taking new requests, let the
// ones in progress finish, then close the database connections.
let stopping = false;

function shutdown() {
  if (stopping) return; // a second Ctrl-C while we're already stopping
  stopping = true;
  logger.info('API shutting down');

  // If some request is still stuck after 10 seconds, stop waiting for it.
  setTimeout(() => process.exit(1), 10_000).unref();

  server.close(() => {
    db.end().finally(() => process.exit(0));
  });
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

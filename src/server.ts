import { app } from './app.js';
import { config } from './config.js';
import { db } from './db.js';

// Starts the API: `npm run dev` (restarts on file changes) or `npm start`.
const server = app.listen(config.PORT, () => {
  console.log(`API listening on http://localhost:${config.PORT}`);
});

// Clean shutdown (Ctrl-C): stop taking new requests, let the ones in progress finish, then close
// the database connections. Everything is already saved in PostgreSQL, so a restart loses nothing.
function shutdown() {
  console.log('API shutting down');
  setTimeout(() => process.exit(1), 10_000).unref(); // don't wait forever for a stuck request
  server.close(() => {
    db.end().finally(() => process.exit(0));
  });
}

process.once('SIGTERM', shutdown);
process.once('SIGINT', shutdown);

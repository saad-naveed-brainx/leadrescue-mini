import { app } from '../../src/app.js';
import { db } from '../../src/db.js';

/** The app, and the shared database pool it uses. End the pool in afterAll. */
export function testApp() {
  return { pool: db, app };
}

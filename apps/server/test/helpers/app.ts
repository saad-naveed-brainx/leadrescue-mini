import { createApp } from '../../src/http/app.js';
import { testPool } from './db.js';

/** A pool on the test database and an app using it. End the pool in afterAll. */
export function testApp() {
  const pool = testPool();
  return { pool, app: createApp({ pool }) };
}

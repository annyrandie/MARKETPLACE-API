import { Pool } from 'pg';

// The same five fields, copy-pasted into four entry points (every demo
// script plus consumer-worker.ts) before this existed — one place to
// change if the connection config ever needs a new field (pool size,
// SSL), instead of four, where missing one leaves that script silently
// running on stale settings.
export function createDbPool(): Pool {
  return new Pool({
    host: process.env.DB_HOST,
    port: Number(process.env.DB_PORT),
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
  });
}

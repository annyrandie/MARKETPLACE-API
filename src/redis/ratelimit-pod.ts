// One "pod" for demo:ratelimit — a separate OS process (child_process.fork),
// so nothing can be shared with the other pod through module state: if the
// limit still holds across two of these, the counter really lives in Redis.
//
// RATE_LIMIT_STORE=memory swaps in a per-process limiter — demo:ratelimit
// --in-memory's control run, which must let through LIMIT × pods.
import type { AddressInfo } from 'node:net';
import express, { type NextFunction, type Request, type Response } from 'express';
import { createStateRedis } from './connections';
import { RedisRateLimiter } from './rate-limit';

const LIMIT = Number(process.env.RATE_LIMIT ?? 5);
const WINDOW_MS = Number(process.env.RATE_LIMIT_WINDOW_MS ?? 10_000);
const PREFIX = process.env.RATE_LIMIT_PREFIX ?? 'demo-products';
const IN_MEMORY = process.env.RATE_LIMIT_STORE === 'memory';

const clientId = (req: Request) => String(req.headers['x-client-id'] ?? req.ip);

// The bug the assignment warns about, on purpose: a Map in this process.
function inMemoryLimiter() {
  const hits = new Map<string, number[]>();
  return (req: Request, res: Response, next: NextFunction) => {
    const now = Date.now();
    const log = (hits.get(clientId(req)) ?? []).filter((t) => t > now - WINDOW_MS);
    if (log.length >= LIMIT) {
      res.setHeader('Retry-After', String(Math.ceil((log[0] + WINDOW_MS - now) / 1000)));
      next(Object.assign(new Error(`limit ${LIMIT}`), { status: 429 }));
      return;
    }
    log.push(now);
    hits.set(clientId(req), log);
    next();
  };
}

const redis = IN_MEMORY ? null : createStateRedis();
const limit = redis
  ? new RedisRateLimiter(redis, { limit: LIMIT, windowMs: WINDOW_MS, prefix: PREFIX, clientId }).middleware()
  : inMemoryLimiter();

const app = express();
app.get('/products', limit, (_req, res) => res.json({ pid: process.pid }));
// stand-in for app.js's problem+json filter
app.use((err: Error & { status?: number }, _req: Request, res: Response, _next: NextFunction) => {
  res.status(err.status ?? 500).json({ title: 'Error', status: err.status ?? 500, detail: err.message });
});

const server = app.listen(0, '127.0.0.1', () => {
  process.send?.({ port: (server.address() as AddressInfo).port, pid: process.pid });
});

// the parent disconnects the IPC channel to stop us
process.on('disconnect', () => {
  server.close();
  void redis?.quit();
});

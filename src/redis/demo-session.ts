// npm run demo:session — Redis-backed sessions with a rolling TTL.
//
//   POST /login → wait → GET /me → wait → (PTTL before) GET /me (PTTL after)
//   → "restart": close the app AND its Redis connection, boot a fresh one
//   → GET /me with the same cookie → POST /logout → GET /me (401).
//
// Waits are real (1.5s): without them the TTL has no time to drop, and
// ttl-renewed would be 0 even on a correct rolling implementation. PTTL
// (ms), not TTL (s): a 1.5s drop is invisible at whole-second resolution
// often enough to make the demo flaky.
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import express from 'express';
import type Redis from 'ioredis';
import { finish } from '../outbox/demo-kit';
import { createStateRedis } from './connections';
import { RedisSessionStore, readCookie, requireSession, sessionMiddleware, setSessionCookie } from './session';

const WAIT_MS = 1500;
const DEMO_USER = 'session-demo-user';

interface Pod {
  url: string;
  redis: Redis;
  server: Server;
}

async function startPod(): Promise<Pod> {
  const redis = createStateRedis();
  const store = new RedisSessionStore(redis);
  const app = express();
  app.use(express.json());
  app.use(sessionMiddleware(store));
  app.post('/login', async (req, res, next) => {
    try {
      const { token, id } = await store.create(String(req.body?.userId ?? DEMO_USER));
      setSessionCookie(res, store, token);
      res.status(201).json({ sessionId: id });
    } catch (err) {
      next(err);
    }
  });
  app.get('/me', requireSession, (req, res) => {
    res.json({ sessionId: req.session!.id, userId: req.session!.userId });
  });
  app.post('/logout', requireSession, async (req, res, next) => {
    try {
      await store.destroy(readCookie(req, store.opts.cookieName) ?? '');
      res.status(204).end();
    } catch (err) {
      next(err);
    }
  });
  const server = await new Promise<Server>((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, redis, server };
}

// client side: the token out of the `sid=…` pair the demo holds
function tokenFromCookie(cookie: string): string {
  const m = /(?:^|;\s*)sid=([^;]+)/.exec(cookie);
  return m ? decodeURIComponent(m[1]) : '';
}

async function stopPod(pod: Pod): Promise<void> {
  await new Promise<void>((r) => pod.server.close(() => r()));
  await pod.redis.quit();
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main(): Promise<void> {
  const probe = createStateRedis(); // the demo's own view of Redis, not the app's
  let pod = await startPod();
  let requests = 0;
  const sessionIds = new Set<string>();
  let cookie = '';

  const call = async (method: 'GET' | 'POST', path: string) => {
    requests += 1;
    const res = await fetch(pod.url + path, {
      method,
      headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) },
      body: method === 'POST' ? JSON.stringify({ userId: DEMO_USER }) : undefined,
    });
    const setCookie = res.headers.get('set-cookie');
    if (setCookie) cookie = setCookie.split(';')[0];
    const body = res.status === 204 ? null : ((await res.json()) as { sessionId?: string });
    if (body?.sessionId) sessionIds.add(body.sessionId);
    console.error(`${method} ${path} → ${res.status}`);
    return res.status;
  };

  let summary: Record<string, number>;
  let key = '';
  try {
    await call('POST', '/login');
    key = RedisSessionStore.keyFor(RedisSessionStore.idFromToken(tokenFromCookie(cookie)));

    await sleep(WAIT_MS);
    const okBefore = (await call('GET', '/me')) === 200;

    await sleep(WAIT_MS);
    const pttlBefore = await probe.pttl(key);
    const okActive = (await call('GET', '/me')) === 200;
    const pttlAfter = await probe.pttl(key);
    console.error(`PTTL before activity: ${pttlBefore}ms, after: ${pttlAfter}ms`);

    const inRedis = await probe.exists(key);

    // "restart the process": new app, new Redis connection, same cookie
    await stopPod(pod);
    pod = await startPod();
    const survived = (await call('GET', '/me')) === 200;

    const loggedOut = (await call('POST', '/logout')) === 204 && (await call('GET', '/me')) === 401;
    const goneFromRedis = (await probe.exists(key)) === 0;

    summary = {
      requests,
      sessions: sessionIds.size,
      'in-redis': inRedis,
      'ttl-renewed': okBefore && okActive && pttlAfter > pttlBefore ? 1 : 0,
      'survived-restart': survived ? 1 : 0,
      'logout-deleted': loggedOut && goneFromRedis ? 1 : 0,
    };
  } finally {
    if (key) await probe.del(key);
    await stopPod(pod);
    await probe.quit();
  }

  finish(summary, {
    'one session across all requests': summary.sessions === 1 && summary.requests >= 3,
    'session stored in Redis': summary['in-redis'] === 1,
    'TTL rolls on activity': summary['ttl-renewed'] === 1,
    'survives a process restart': summary['survived-restart'] === 1,
    'logout removes it': summary['logout-deleted'] === 1,
  });
}

main().catch((err) => {
  console.error('demo:session failed:', err);
  process.exit(1);
});

// npm run demo:ratelimit — one limit shared by two "pods".
//
// Two independent HTTP servers, each with its OWN Redis connection and its
// OWN limiter instance (nothing shared in-process), behind a round-robin
// "load balancer". REQUESTS hits from one client, split across both pods: allowed must equal LIMIT (not 2 × LIMIT, which is what
// two in-memory counters would give), the rest get 429 + Retry-After.
//
// Two rounds, each with its own fresh client id:
//  1. alternating pod-0, pod-1, … one by one — both pods serve, and the
//     sum is still LIMIT (the contract numbers come from this round);
//  2. the same number fired all at once — what makes a non-atomic
//     check-then-add leak; burst-allowed must be LIMIT too.
import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import express from 'express';
import type Redis from 'ioredis';
import { finish } from '../outbox/demo-kit';
import { createStateRedis } from './connections';
import { RedisRateLimiter } from './rate-limit';

const PODS = 2;
const LIMIT = 5;
const WINDOW_MS = 10_000;
const REQUESTS = 12;
const PREFIX = 'demo-products';

interface Pod {
  url: string;
  redis: Redis;
  server: Server;
}

async function startPod(name: string): Promise<Pod> {
  const redis = createStateRedis();
  const limiter = new RedisRateLimiter(redis, {
    limit: LIMIT,
    windowMs: WINDOW_MS,
    prefix: PREFIX,
    clientId: (req) => String(req.headers['x-client-id'] ?? req.ip),
  });
  const app = express();
  app.get('/products', limiter.middleware(), (_req, res) => res.json({ pod: name }));
  const server = await new Promise<Server>((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, redis, server };
}

async function main(): Promise<void> {
  const pods = await Promise.all(Array.from({ length: PODS }, (_, i) => startPod(`pod-${i}`)));
  const clientIds: string[] = [];
  const run = async (concurrent: boolean) => {
    const clientId = `demo-${randomUUID()}`; // fresh bucket for every round
    clientIds.push(clientId);
    const hit = (i: number) => fetch(`${pods[i % PODS].url}/products`, { headers: { 'x-client-id': clientId } });
    const responses: Response[] = [];
    if (concurrent) responses.push(...(await Promise.all(Array.from({ length: REQUESTS }, (_, i) => hit(i)))));
    else for (let i = 0; i < REQUESTS; i++) responses.push(await hit(i));
    await Promise.all(responses.map((r) => r.arrayBuffer()));
    const allowedPerPod = pods.map((p) => responses.filter((r) => r.status === 200 && r.url.startsWith(p.url)).length);
    const blocked = responses.filter((r) => r.status !== 200);
    return { allowedPerPod, allowed: allowedPerPod.reduce((a, b) => a + b, 0), blocked, last: blocked[blocked.length - 1] };
  };

  let summary: Record<string, number>;
  try {
    const seq = await run(false);
    console.error(`sequential: allowed per pod ${seq.allowedPerPod.join(' + ')}; Retry-After: ${seq.last?.headers.get('retry-after')}s`);
    const burst = await run(true);
    console.error(`burst:      allowed per pod ${burst.allowedPerPod.join(' + ')}`);

    summary = {
      instances: PODS,
      limit: LIMIT,
      requests: REQUESTS,
      allowed: seq.allowed,
      blocked: seq.blocked.length,
      status: seq.last?.status ?? 0,
      'retry-after': seq.last?.headers.get('retry-after') ? 1 : 0,
      'pods-served': seq.allowedPerPod.filter((n) => n > 0).length,
      'burst-allowed': burst.allowed,
    };
  } finally {
    await pods[0].redis.del(...clientIds.map((id) => `rl:${PREFIX}:${id}`));
    for (const p of pods) {
      await new Promise<void>((r) => p.server.close(() => r()));
      await p.redis.quit();
    }
  }

  finish(summary, {
    'shared limit across pods': summary.instances >= 2 && summary.allowed === summary.limit && summary['pods-served'] >= 2,
    'atomic under a concurrent burst': summary['burst-allowed'] === summary.limit,
    'excess rejected with 429 + Retry-After': summary.blocked >= 1 && summary.status === 429 && summary['retry-after'] === 1,
  });
}

main().catch((err) => {
  console.error('demo:ratelimit failed:', err);
  process.exit(1);
});

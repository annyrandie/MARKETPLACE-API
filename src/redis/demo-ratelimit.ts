// npm run demo:ratelimit — one limit shared by two "pods".
//
// Each pod is its own OS process (child_process.fork of ratelimit-pod.js):
// its own HTTP server, its own Redis connection, its own limiter, and no
// shared module state with the other pod — a Map in a module would be
// per process here, exactly as in production. The demo plays a round-robin
// load balancer in front of them. REQUESTS hits from one client, split
// across both pods: allowed must equal LIMIT, not LIMIT × pods.
//
// Two rounds, each with its own fresh client id:
//  1. alternating pod-0, pod-1, … one by one — both pods serve, and the
//     sum is still LIMIT (the contract numbers come from this round);
//  2. the same number fired all at once — what makes a non-atomic
//     check-then-add leak; burst-allowed must be LIMIT too.
//
// Control run: `node dist/redis/demo-ratelimit.js --in-memory` — the pods
// count in process memory instead; allowed becomes LIMIT × pods and the
// invariant fails. That's the proof this demo can tell the two apart.
import { randomUUID } from 'node:crypto';
import { fork, type ChildProcess } from 'node:child_process';
import path from 'node:path';
import { finish } from '../outbox/demo-kit';
import { createStateRedis } from './connections';

const PODS = 2;
const LIMIT = 5;
const WINDOW_MS = 10_000;
const REQUESTS = 12;
const PREFIX = 'demo-products';
const IN_MEMORY = process.argv.includes('--in-memory');

interface Pod {
  url: string;
  pid: number;
  child: ChildProcess;
}

function startPod(): Promise<Pod> {
  const child = fork(path.join(__dirname, 'ratelimit-pod.js'), [], {
    env: {
      ...process.env,
      RATE_LIMIT: String(LIMIT),
      RATE_LIMIT_WINDOW_MS: String(WINDOW_MS),
      RATE_LIMIT_PREFIX: PREFIX,
      RATE_LIMIT_STORE: IN_MEMORY ? 'memory' : 'redis',
    },
  });
  return new Promise((resolve, reject) => {
    child.once('message', (m: { port: number; pid: number }) =>
      resolve({ url: `http://127.0.0.1:${m.port}`, pid: m.pid, child }),
    );
    child.once('error', reject);
    child.once('exit', (code) => reject(new Error(`pod exited early with code ${code}`)));
  });
}

async function main(): Promise<void> {
  const redis = createStateRedis(); // the demo's own connection, for cleanup only
  const pods = await Promise.all(Array.from({ length: PODS }, () => startPod()));
  console.error(`pods: ${pods.map((p) => `pid ${p.pid}`).join(', ')} (parent pid ${process.pid})${IN_MEMORY ? ' — IN-MEMORY control run' : ''}`);

  const clientIds: string[] = [];
  const run = async (concurrent: boolean) => {
    const clientId = `demo-${randomUUID()}`; // fresh bucket for every round
    clientIds.push(clientId);
    const hit = (i: number) => fetch(`${pods[i % PODS].url}/products`, { headers: { 'x-client-id': clientId } });
    const responses: Response[] = [];
    if (concurrent) responses.push(...(await Promise.all(Array.from({ length: REQUESTS }, (_, i) => hit(i)))));
    else for (let i = 0; i < REQUESTS; i++) responses.push(await hit(i));
    const bodies = await Promise.all(responses.map((r) => r.json() as Promise<{ pid?: number }>));
    const servedBy = bodies.filter((b) => b.pid !== undefined).map((b) => b.pid);
    const allowedPerPod = pods.map((p) => servedBy.filter((pid) => pid === p.pid).length);
    const blocked = responses.filter((r) => r.status !== 200);
    return { allowedPerPod, allowed: servedBy.length, blocked, last: blocked[blocked.length - 1] };
  };

  let summary: Record<string, number>;
  try {
    const seq = await run(false);
    console.error(`sequential: allowed per pod ${seq.allowedPerPod.join(' + ')}; Retry-After: ${seq.last?.headers.get('retry-after')}s`);
    const burst = await run(true);
    console.error(`burst:      allowed per pod ${burst.allowedPerPod.join(' + ')}`);

    summary = {
      instances: PODS,
      processes: new Set(pods.map((p) => p.pid).filter((pid) => pid !== process.pid)).size,
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
    await redis.del(...clientIds.map((id) => `rl:${PREFIX}:${id}`)).catch(() => {});
    await redis.quit();
    await Promise.all(
      pods.map((p) => new Promise<void>((r) => (p.child.exitCode !== null ? r() : (p.child.once('exit', () => r()), p.child.disconnect())))),
    );
  }

  finish(summary, {
    'pods are separate processes': summary.processes === PODS,
    'shared limit across pods': summary.allowed === summary.limit && summary['pods-served'] >= 2,
    'atomic under a concurrent burst': summary['burst-allowed'] === summary.limit,
    'excess rejected with 429 + Retry-After': summary.blocked >= 1 && summary.status === 429 && summary['retry-after'] === 1,
  });
}

main().catch((err) => {
  console.error('demo:ratelimit failed:', err);
  process.exit(1);
});

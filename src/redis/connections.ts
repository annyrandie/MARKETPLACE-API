import Redis, { RedisOptions } from 'ioredis';

// Two boxes, two env vars — never one URL with a different DB index:
// maxmemory-policy is per process, SELECT doesn't split it (see
// docker-compose.yml). Both come from scripts/with-secrets.sh, never from
// a hardcoded default here: a missing variable is a misconfigured run, and
// silently falling back to "whatever is on 6379" would point the queue at
// the LRU box — exactly the bug the two instances exist to prevent.
function requireUrl(name: 'REDIS_URL' | 'REDIS_QUEUE_URL'): string {
  const url = process.env[name];
  if (!url) {
    throw new Error(`${name} is not set — run via: bash scripts/with-secrets.sh dev <command>`);
  }
  return url;
}

/** The cache box (allkeys-lru). Fail fast: a cache read that hangs on a
 *  reconnect is worse than a miss — the caller falls through to the DB. */
export function createCacheRedis(opts: RedisOptions = {}): Redis {
  return new Redis(requireUrl('REDIS_URL'), { maxRetriesPerRequest: 1, ...opts });
}

/** The queue box (noeviction) for request-path use — sessions, rate
 *  limits, Queue.add(). Fail fast here too: an HTTP request shouldn't wait
 *  forever for Redis to come back. */
export function createStateRedis(opts: RedisOptions = {}): Redis {
  return new Redis(requireUrl('REDIS_QUEUE_URL'), { maxRetriesPerRequest: 1, ...opts });
}

/** The queue box for BullMQ Workers: `maxRetriesPerRequest: null`, or
 *  ioredis throws on a dropped connection and the worker dies instead of
 *  waiting for Redis to come back (BullMQ's own docs). */
export function createWorkerRedis(): Redis {
  return new Redis(requireUrl('REDIS_QUEUE_URL'), { maxRetriesPerRequest: null });
}

/** CONFIG GET as the demos' runtime proof of which box they're on. Managed
 *  Redis often disables CONFIG — then we honestly report "unknown". */
export async function readMemoryConfig(redis: Redis): Promise<{ policy: string | null; maxmemory: number | null }> {
  try {
    const [, policy] = (await redis.config('GET', 'maxmemory-policy')) as string[];
    const [, maxmemory] = (await redis.config('GET', 'maxmemory')) as string[];
    return { policy: policy ?? null, maxmemory: maxmemory === undefined ? null : Number(maxmemory) };
  } catch {
    return { policy: null, maxmemory: null };
  }
}

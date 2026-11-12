import { randomInt, randomUUID } from 'node:crypto';
import type Redis from 'ioredis';

export interface CacheAsideOptions {
  /** Base TTL in seconds — always set, explicit invalidation is extra. */
  ttlSeconds: number;
  /** Uniform jitter added on top: TTL = ttlSeconds + random(0..jitterSeconds).
   *  Keys warmed by one loop otherwise all expire in the same second and
   *  stampede the DB together. */
  jitterSeconds: number;
  /** How long a single-flight lock lives. Must comfortably exceed one
   *  loader call; if the winner dies, the lock frees itself after this. */
  lockTtlMs: number;
  /** How often losers re-read the cache while the winner loads. */
  pollMs: number;
  /** false = plain cache-aside, every miss loads (demo:cache --no-lock,
   *  the control run that shows what the lock is saving). */
  singleFlight: boolean;
}

export const DEFAULT_CACHE_OPTIONS: CacheAsideOptions = {
  ttlSeconds: 300,
  jitterSeconds: 60,
  lockTtlMs: 3000,
  pollMs: 25,
  singleFlight: true,
};

// Compare-and-delete: release the lock only if it's still OURS. A bare
// DEL after our lock expired would delete whoever took it next. Lua, not
// DELEX … IFEQ, so it runs on any Redis version (compose pins 8.4, but
// nothing here should silently depend on that).
const RELEASE_LOCK = `
if redis.call("get", KEYS[1]) == ARGV[1] then
  return redis.call("del", KEYS[1])
else
  return 0
end`;

// Values are wrapped so a cached "not found" (null) is distinguishable
// from a miss — otherwise every request for a missing id goes to the DB.
interface Envelope<T> {
  v: T;
}

export function jitteredTtl(opts: Pick<CacheAsideOptions, 'ttlSeconds' | 'jitterSeconds'>): number {
  return opts.ttlSeconds + randomInt(0, opts.jitterSeconds + 1);
}

/**
 * Cache-aside + single-flight. Redis here is an optimisation, never a
 * source of truth — so every Redis failure degrades to "go to the DB",
 * never to a failed request:
 *
 * - hit → return, no DB;
 * - miss → `SET lock:<key> <token> NX PX` — exactly one caller wins and
 *   runs the loader; everyone else polls the cache until the winner has
 *   written it (or the lock disappears, and one of them takes over);
 * - the winner re-checks the cache after taking the lock (the previous
 *   holder may have just filled it), writes with a jittered TTL, then
 *   releases the lock with compare-and-delete.
 *
 * If this lock ever breaks (lock TTL < a GC pause, a Redis failover), two
 * callers load at once: one extra DB read, same result. That's why a
 * plain Redis lock is enough HERE — and why it's not enough for anything
 * that guards state (see README, "що станеться, якщо лок зламається").
 */
export class CacheAside {
  constructor(
    private readonly redis: Redis,
    private readonly opts: CacheAsideOptions = DEFAULT_CACHE_OPTIONS,
  ) {}

  async get<T>(key: string, loader: () => Promise<T>): Promise<T> {
    const cached = await this.read<T>(key);
    if (cached) return cached.v;
    if (!this.opts.singleFlight) {
      const value = await loader();
      await this.write(key, value);
      return value;
    }

    const lockKey = `lock:${key}`;
    const token = randomUUID();
    const deadline = Date.now() + this.opts.lockTtlMs * 2;

    while (Date.now() < deadline) {
      if (await this.tryLock(lockKey, token)) {
        try {
          const again = await this.read<T>(key);
          if (again) return again.v;
          const value = await loader();
          await this.write(key, value);
          return value;
        } finally {
          await this.redis.eval(RELEASE_LOCK, 1, lockKey, token).catch(() => {});
        }
      }
      await sleep(this.opts.pollMs);
      const filled = await this.read<T>(key);
      if (filled) return filled.v;
    }
    // The lock holder is stuck and Redis never got the value: stop waiting
    // and serve from the DB. Slower, still correct.
    return loader();
  }

  async invalidate(key: string): Promise<void> {
    await this.redis.del(key).catch(() => {});
  }

  private async read<T>(key: string): Promise<Envelope<T> | null> {
    try {
      const raw = await this.redis.get(key);
      return raw === null ? null : (JSON.parse(raw) as Envelope<T>);
    } catch {
      return null; // Redis down or garbage in the key → treat as a miss
    }
  }

  private async write<T>(key: string, value: T): Promise<void> {
    try {
      await this.redis.set(key, JSON.stringify({ v: value }), 'EX', jitteredTtl(this.opts));
    } catch (err) {
      // e.g. "OOM command not allowed" on a misconfigured box: the user
      // still gets their answer, the next request just misses again.
      console.error('[cache] write failed:', err instanceof Error ? err.message : err);
    }
  }

  private async tryLock(lockKey: string, token: string): Promise<boolean> {
    try {
      return (await this.redis.set(lockKey, token, 'PX', this.opts.lockTtlMs, 'NX')) === 'OK';
    } catch {
      // Can't reach Redis to coordinate → don't block on it, just load.
      // Worst case: N loaders instead of one. Acceptable for a cache.
      return true;
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

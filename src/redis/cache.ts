import { randomInt, randomUUID } from 'node:crypto';
import type Redis from 'ioredis';

export interface CacheAsideOptions {
  /** How long a value is FRESH, in seconds. */
  ttlSeconds: number;
  /** Uniform jitter added on top: fresh for ttlSeconds + random(0..jitterSeconds).
   *  Keys warmed by one loop otherwise all expire in the same second and
   *  stampede the DB together. */
  jitterSeconds: number;
  /** How long a value is kept AFTER it stops being fresh. While it's
   *  stale, one caller reloads and everyone else gets the stale copy right
   *  away instead of waiting. The Redis TTL is always set (fresh + stale),
   *  so nothing lives forever. */
  staleSeconds: number;
  /** TTL for a cached "not found": short, so a product created a minute
   *  later doesn't stay 404 for the full TTL. */
  nullTtlSeconds: number;
  /** How long a single-flight lock lives. Must comfortably exceed the
   *  slowest loader call: if it runs out mid-load, a second caller takes
   *  the lock and loads too (see README, "якщо лок зламається"). */
  lockTtlMs: number;
  /** How long a caller with NOTHING to serve (no fresh, no stale copy)
   *  waits for the lock holder before giving up with CacheBusyError. Kept
   *  below lockTtlMs on purpose: giving up must never mean "go to the DB
   *  anyway" — on a slow DB that would bring the stampede right back. */
  waitTimeoutMs: number;
  /** How often waiting callers re-read the cache. */
  pollMs: number;
  /** false = plain cache-aside, every miss loads (demo:cache --no-lock,
   *  the control run that shows what single-flight is saving). */
  singleFlight: boolean;
}

export const DEFAULT_CACHE_OPTIONS: CacheAsideOptions = {
  ttlSeconds: 300,
  jitterSeconds: 60,
  staleSeconds: 120,
  nullTtlSeconds: 30,
  lockTtlMs: 5000,
  waitTimeoutMs: 1000,
  pollMs: 25,
  singleFlight: true,
};

/** Nothing to serve yet and the one loader hasn't finished in time. The
 *  HTTP layer turns this into 503 + Retry-After — load is shed, not
 *  forwarded to an already slow database. */
export class CacheBusyError extends Error {
  constructor(
    readonly key: string,
    readonly retryAfterSeconds: number,
  ) {
    super(`cache entry "${key}" is being rebuilt, try again in ${retryAfterSeconds}s`);
    this.name = 'CacheBusyError';
  }
}

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

// v = the value (null = cached "not found", distinguishable from a miss);
// f = fresh until, epoch ms. Past f but still in Redis = stale.
interface Envelope<T> {
  v: T;
  f: number;
}

export function jitteredTtl(opts: Pick<CacheAsideOptions, 'ttlSeconds' | 'jitterSeconds'>): number {
  return opts.ttlSeconds + randomInt(0, opts.jitterSeconds + 1);
}

/**
 * Cache-aside + single-flight + stale-while-revalidate. Redis here is an
 * optimisation, never a source of truth, so a Redis failure degrades to
 * "go to the DB", never to a failed request. Two layers of single-flight:
 *
 * 1. in-process: concurrent callers in THIS process share one promise per
 *    key — at most one load per pod even if Redis is unreachable;
 * 2. across pods: `SET lock:<key> <token> NX PX` — exactly one pod wins.
 *
 * What the losers do depends on what's in the cache:
 * - a stale copy → return it immediately (the winner refreshes it);
 * - nothing → poll for up to waitTimeoutMs, take over the lock if its
 *   holder vanished, otherwise throw CacheBusyError. Never "everyone
 *   loads after a timeout".
 *
 * If the lock ever breaks (a pause longer than lockTtlMs, a Redis
 * failover), two pods load at once: one extra DB read, same result. That's
 * why a plain Redis lock is enough HERE — and why it isn't for anything
 * that guards state (see README).
 */
export class CacheAside {
  private readonly inflight = new Map<string, Promise<unknown>>();

  constructor(
    private readonly redis: Redis,
    private readonly opts: CacheAsideOptions = DEFAULT_CACHE_OPTIONS,
  ) {}

  async get<T>(key: string, loader: () => Promise<T>): Promise<T> {
    const hit = await this.read<T>(key);
    if (hit && hit.f > Date.now()) return hit.v;
    if (!this.opts.singleFlight) return this.loadAndWrite(key, loader);

    const running = this.inflight.get(key) as Promise<T> | undefined;
    if (running) return hit ? hit.v : running;
    const p = this.refresh(key, loader, hit).finally(() => this.inflight.delete(key));
    this.inflight.set(key, p);
    return p;
  }

  /** Soft invalidation on a write: the value stays servable, but the next
   *  read refreshes it (one caller loads, the rest get the old copy) — a
   *  DEL would instead make every concurrent reader wait or fail. */
  async markStale(key: string): Promise<void> {
    try {
      const raw = await this.redis.get(key);
      if (raw === null) return;
      const env = JSON.parse(raw) as Envelope<unknown>;
      await this.redis.set(key, JSON.stringify({ ...env, f: 0 }), 'KEEPTTL');
    } catch {
      // can't reach Redis → the value expires on its own TTL
    }
  }

  async invalidate(key: string): Promise<void> {
    await this.redis.del(key).catch(() => {});
  }

  private async refresh<T>(key: string, loader: () => Promise<T>, stale: Envelope<T> | null): Promise<T> {
    const lockKey = `lock:${key}`;
    const token = randomUUID();

    if (await this.tryLock(lockKey, token)) return this.loadAsWinner(key, lockKey, token, loader);
    if (stale) return stale.v; // someone else is refreshing — serve stale, don't wait

    const deadline = Date.now() + this.opts.waitTimeoutMs;
    while (Date.now() < deadline) {
      await sleep(this.opts.pollMs);
      const filled = await this.read<T>(key);
      if (filled) return filled.v;
      // holder died / its load failed and it released → take over
      if (await this.tryLock(lockKey, token)) return this.loadAsWinner(key, lockKey, token, loader);
    }
    throw new CacheBusyError(key, Math.max(1, Math.ceil(this.opts.waitTimeoutMs / 1000)));
  }

  private async loadAsWinner<T>(key: string, lockKey: string, token: string, loader: () => Promise<T>): Promise<T> {
    try {
      const again = await this.read<T>(key);
      if (again && again.f > Date.now()) return again.v; // previous holder just filled it
      return await this.loadAndWrite(key, loader);
    } finally {
      await this.redis.eval(RELEASE_LOCK, 1, lockKey, token).catch(() => {});
    }
  }

  private async loadAndWrite<T>(key: string, loader: () => Promise<T>): Promise<T> {
    const value = await loader();
    const freshSeconds = value === null ? this.opts.nullTtlSeconds : jitteredTtl(this.opts);
    const envelope: Envelope<T> = { v: value, f: Date.now() + freshSeconds * 1000 };
    try {
      await this.redis.set(key, JSON.stringify(envelope), 'EX', freshSeconds + this.opts.staleSeconds);
    } catch (err) {
      // e.g. "OOM command not allowed" on a misconfigured box: the user
      // still gets their answer, the next request just misses again.
      console.error('[cache] write failed:', err instanceof Error ? err.message : err);
    }
    return value;
  }

  private async read<T>(key: string): Promise<Envelope<T> | null> {
    try {
      const raw = await this.redis.get(key);
      return raw === null ? null : (JSON.parse(raw) as Envelope<T>);
    } catch {
      return null; // Redis down or garbage in the key → treat as a miss
    }
  }

  private async tryLock(lockKey: string, token: string): Promise<boolean> {
    try {
      return (await this.redis.set(lockKey, token, 'PX', this.opts.lockTtlMs, 'NX')) === 'OK';
    } catch {
      // Can't reach Redis to coordinate → load. The in-process layer still
      // caps it at one load per pod per key, not one per request.
      return true;
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

import { randomUUID } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import type Redis from 'ioredis';

export interface RateLimitOptions {
  limit: number;
  windowMs: number;
  /** Namespaces the counter: one bucket per (prefix, client). */
  prefix: string;
  /** Who is "one client" — API key, user id, IP. */
  clientId: (req: Request) => string;
}

export interface RateLimitDecision {
  allowed: boolean;
  remaining: number;
  retryAfterMs: number;
}

// Sliding-window log, as ONE script: trim → count → maybe add is atomic on
// the Redis side. As three separate commands, two pods can both read
// count=limit-1 between someone's ZCARD and ZADD and both get in — the
// limit leaks exactly under the load it exists for. Here atomicity is a
// correctness requirement (unlike the cache lock, where it's an
// optimisation).
//
// "now" comes from Redis's own TIME, not from ARGV: pods' clocks drift,
// the one Redis clock is the same for all of them.
const SLIDING_WINDOW = `
local key    = KEYS[1]
local window = tonumber(ARGV[1])
local limit  = tonumber(ARGV[2])
local member = ARGV[3]
local t      = redis.call('TIME')
local now    = tonumber(t[1]) * 1000 + math.floor(tonumber(t[2]) / 1000)

redis.call('ZREMRANGEBYSCORE', key, '-inf', now - window)
local count = redis.call('ZCARD', key)
if count < limit then
  redis.call('ZADD', key, now, member)
  redis.call('PEXPIRE', key, window)
  return {1, limit - count - 1, 0}
end
local oldest = redis.call('ZRANGE', key, 0, 0, 'WITHSCORES')
return {0, 0, tonumber(oldest[2]) + window - now}
`;

/**
 * A limiter whose state lives in Redis, so N pods share ONE limit — an
 * in-process counter would quietly let through limit × pods.
 *
 * Sliding window, not token bucket or fixed window: this guards against
 * a single client hammering an endpoint, and we deliberately DON'T want
 * to allow a burst — a fixed window lets 2× limit through around the
 * boundary, a token bucket allows a full bucket at once.
 */
export class RedisRateLimiter {
  constructor(
    private readonly redis: Redis,
    readonly opts: RateLimitOptions,
  ) {}

  async hit(clientId: string): Promise<RateLimitDecision> {
    const [allowed, remaining, retryAfterMs] = (await this.redis.eval(
      SLIDING_WINDOW,
      1,
      `rl:${this.opts.prefix}:${clientId}`,
      this.opts.windowMs,
      this.opts.limit,
      randomUUID(), // unique member: two hits in the same ms are still two hits
    )) as [number, number, number];
    return { allowed: allowed === 1, remaining, retryAfterMs };
  }

  middleware() {
    return async (req: Request, res: Response, next: NextFunction) => {
      let decision: RateLimitDecision;
      try {
        decision = await this.hit(this.opts.clientId(req));
      } catch (err) {
        // Fail OPEN: the limiter protects capacity, it isn't a security
        // boundary here — Redis being down shouldn't take the API down too.
        console.error('[rate-limit] Redis unavailable, letting request through:', err instanceof Error ? err.message : err);
        return next();
      }
      res.setHeader('RateLimit-Limit', String(this.opts.limit));
      res.setHeader('RateLimit-Remaining', String(decision.remaining));
      if (decision.allowed) return next();
      res.setHeader('Retry-After', String(Math.max(1, Math.ceil(decision.retryAfterMs / 1000))));
      res.status(429).type('application/problem+json').json({
        title: 'Too Many Requests',
        status: 429,
        detail: `limit ${this.opts.limit} per ${this.opts.windowMs / 1000}s`,
      });
    };
  }
}

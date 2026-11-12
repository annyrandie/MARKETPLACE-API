import { createHash, randomBytes } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import type Redis from 'ioredis';

export interface SessionData {
  userId: string;
  createdAt: number;
}

export interface SessionOptions {
  /** Idle timeout: every request that reads the session pushes it this far
   *  into the future (rolling TTL). */
  idleTtlSeconds: number;
  /** Hard cap from login, regardless of activity — rolling alone would let
   *  a session that's used once a day live forever. */
  absoluteTtlSeconds: number;
  cookieName: string;
}

export const DEFAULT_SESSION_OPTIONS: SessionOptions = {
  idleTtlSeconds: 30 * 60,
  absoluteTtlSeconds: 12 * 60 * 60,
  cookieName: 'sid',
};

declare module 'express-serve-static-core' {
  interface Request {
    session?: SessionData & { id: string };
  }
}

/**
 * Sessions as our own token state, no express-session/connect-redis (v10
 * is ESM-only, this build is CJS). Lives on the QUEUE box (noeviction):
 * on the LRU cache box a session would one day be evicted under memory
 * pressure — a logout nobody can reproduce.
 *
 * - The cookie holds 32 random bytes; Redis holds only their SHA-256. A
 *   leaked RDB/AOF or `KEYS sess:*` gives no usable tokens.
 * - Read = `GETEX key EX idleTtl`: read and renew in ONE command, so an
 *   active user's TTL never runs out mid-work, with no read/expire race.
 */
export class RedisSessionStore {
  constructor(
    private readonly redis: Redis,
    readonly opts: SessionOptions = DEFAULT_SESSION_OPTIONS,
  ) {}

  static keyFor(sessionId: string): string {
    return `sess:${sessionId}`;
  }

  /** The public session id (a hash) — what logs and Redis see. */
  static idFromToken(token: string): string {
    return createHash('sha256').update(token).digest('base64url');
  }

  async create(userId: string): Promise<{ token: string; id: string }> {
    const token = randomBytes(32).toString('base64url');
    const id = RedisSessionStore.idFromToken(token);
    const data: SessionData = { userId, createdAt: Date.now() };
    await this.redis.set(RedisSessionStore.keyFor(id), JSON.stringify(data), 'EX', this.opts.idleTtlSeconds);
    return { token, id };
  }

  /** Read + roll the idle TTL. Null if missing, expired or past its
   *  absolute lifetime (then it's deleted right away). */
  async touch(token: string): Promise<(SessionData & { id: string }) | null> {
    const id = RedisSessionStore.idFromToken(token);
    const key = RedisSessionStore.keyFor(id);
    const raw = await this.redis.getex(key, 'EX', this.opts.idleTtlSeconds);
    if (raw === null) return null;
    const data = JSON.parse(raw) as SessionData;
    if (Date.now() - data.createdAt > this.opts.absoluteTtlSeconds * 1000) {
      await this.redis.del(key);
      return null;
    }
    return { ...data, id };
  }

  async destroy(token: string): Promise<void> {
    await this.redis.del(RedisSessionStore.keyFor(RedisSessionStore.idFromToken(token)));
  }
}

export function readCookie(req: Request, name: string): string | undefined {
  for (const part of (req.headers.cookie ?? '').split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return decodeURIComponent(v.join('='));
  }
  return undefined;
}

export function setSessionCookie(res: Response, store: RedisSessionStore, token: string): void {
  // Session cookie (no Max-Age): the browser forgets it on close, the
  // server-side TTL decides the real lifetime.
  res.setHeader('Set-Cookie', `${store.opts.cookieName}=${token}; HttpOnly; SameSite=Lax; Path=/`);
}

/** Loads req.session on every request (renewing its TTL). Doesn't reject
 *  anonymous requests — routes that need a user use requireSession. */
export function sessionMiddleware(store: RedisSessionStore) {
  return async (req: Request, _res: Response, next: NextFunction) => {
    const token = readCookie(req, store.opts.cookieName);
    try {
      req.session = token ? (await store.touch(token)) ?? undefined : undefined;
      next();
    } catch (err) {
      next(err); // state box down → 500, not a silent "you're logged out"
    }
  };
}

export function requireSession(req: Request, res: Response, next: NextFunction): void {
  if (!req.session) {
    res.status(401).type('application/problem+json').json({ title: 'Unauthorized', status: 401 });
    return;
  }
  next();
}

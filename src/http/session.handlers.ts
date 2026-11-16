import type { RequestHandler } from 'express';
import type { Queryable } from '../repositories/queryable';
import { RedisSessionStore, readCookie, setSessionCookie } from '../redis/session';

function httpError(status: number, message: string): Error & { status: number } {
  return Object.assign(new Error(message), { status });
}

/**
 * The session routes of app.js. Login is by e-mail only — there are no
 * passwords in this schema yet; HW #24 adds real authentication on top of
 * this same session. Until then POST /sessions is rate-limited (see
 * app.js), and an unknown e-mail gets the same 401 as any other failure,
 * so the endpoint doesn't confirm which addresses exist.
 */
export function createSessionHandlers(store: RedisSessionStore, db: Queryable) {
  const login: RequestHandler = async (req, res, next) => {
    try {
      const { rows } = await db.query<{ id: string }>(`SELECT id::text AS id FROM users WHERE email = $1`, [req.body.email]);
      if (rows.length === 0) return next(httpError(401, 'invalid credentials'));
      const { token } = await store.create(rows[0].id);
      setSessionCookie(res, store, token);
      res.status(201).json({ user_id: rows[0].id, idle_timeout_seconds: store.opts.idleTtlSeconds });
    } catch (err) {
      next(err);
    }
  };

  // req.session was loaded (and its TTL rolled) by sessionMiddleware
  const current: RequestHandler = (req, res) => {
    res.json({
      user_id: req.session!.userId,
      created_at: new Date(req.session!.createdAt).toISOString(),
      idle_timeout_seconds: store.opts.idleTtlSeconds,
    });
  };

  const logout: RequestHandler = async (req, res, next) => {
    try {
      await store.destroy(readCookie(req, store.opts.cookieName) ?? '');
      res.setHeader('Set-Cookie', `${store.opts.cookieName}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`);
      res.status(204).end();
    } catch (err) {
      next(err);
    }
  };

  return { login, current, logout };
}

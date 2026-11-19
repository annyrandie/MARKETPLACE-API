import type { RequestHandler } from 'express';
import { RedisSessionStore, readCookie, setSessionCookie } from '../redis/session';

function httpError(status: number, message: string): Error & { status: number } {
  return Object.assign(new Error(message), { status });
}

export type VerifyCredentials = (email: string, password: string) => Promise<{ id: string } | null>;

/**
 * The cookie-session routes of app.js (HW #23). Since HW #24 the login
 * checks the password through the SAME verifier as POST /auth/login —
 * one credential check, two ways to carry the result (a server-side
 * session vs a signed token pair). An unknown e-mail gets the same 401 as
 * a wrong password, so the endpoint doesn't confirm which addresses exist.
 */
export function createSessionHandlers(store: RedisSessionStore, verifyCredentials: VerifyCredentials) {
  const login: RequestHandler = async (req, res, next) => {
    try {
      const user = await verifyCredentials(req.body.email, req.body.password);
      if (!user) return next(httpError(401, 'invalid credentials'));
      const { token } = await store.create(user.id);
      setSessionCookie(res, store, token);
      res.status(201).json({ user_id: user.id, idle_timeout_seconds: store.opts.idleTtlSeconds });
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

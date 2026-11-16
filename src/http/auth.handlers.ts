import type { RequestHandler } from 'express';
import { AuthService, InvalidRefreshTokenError } from '../auth/auth.service';

function httpError(status: number, message: string): Error & { status: number } {
  return Object.assign(new Error(message), { status });
}

/** POST /auth/login, /auth/refresh, /auth/logout, GET /auth/me. Tokens
 *  travel only in bodies/headers of these responses — never into a log. */
export function createAuthHandlers(auth: AuthService) {
  const login: RequestHandler = async (req, res, next) => {
    try {
      const pair = await auth.login(req.body.email, req.body.password);
      // one message for "no such user" and "wrong password"
      if (!pair) return next(httpError(401, 'invalid credentials'));
      res.set('Cache-Control', 'no-store').json(pair);
    } catch (err) {
      next(err);
    }
  };

  const refresh: RequestHandler = async (req, res, next) => {
    try {
      const pair = await auth.refresh(req.body.refresh_token);
      res.set('Cache-Control', 'no-store').json(pair);
    } catch (err) {
      if (err instanceof InvalidRefreshTokenError) return next(httpError(401, err.message));
      next(err);
    }
  };

  // behind requireAuth: logging out needs a valid access token (it names
  // the family and the jti to revoke)
  const logout: RequestHandler = async (req, res, next) => {
    try {
      await auth.logout(req.auth!);
      res.status(204).end();
    } catch (err) {
      next(err);
    }
  };

  const me: RequestHandler = (req, res) => {
    res.json({ user_id: req.auth!.sub, role: req.auth!.role, expires_at: new Date(req.auth!.exp * 1000).toISOString() });
  };

  return { login, refresh, logout, me };
}

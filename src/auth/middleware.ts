import type { NextFunction, Request, RequestHandler, Response } from 'express';
import type { AuthService } from './auth.service';
import { InvalidAccessTokenError, type AccessClaims, type Role } from './tokens';

declare module 'express-serve-static-core' {
  interface Request {
    auth?: AccessClaims;
  }
}

function httpError(status: number, message: string): Error {
  return Object.assign(new Error(message), { status });
}

export function bearerToken(req: Request): string | undefined {
  const m = /^Bearer\s+(\S+)$/i.exec(req.get('authorization') ?? '');
  return m?.[1];
}

/**
 * Authentication guard — 401 and ONLY 401: no token, a broken/forged
 * signature, an expired or revoked token. A client SDK answers 401 by
 * refreshing (and then by logging in again).
 *
 * A database error while checking revocation is NOT a 401 — that would
 * send every client into a refresh loop during an outage. It's a 500.
 */
export function requireAuth(auth: AuthService): RequestHandler {
  return async (req, res, next) => {
    const token = bearerToken(req);
    if (!token) {
      res.set('WWW-Authenticate', 'Bearer');
      return next(httpError(401, 'missing bearer token'));
    }
    try {
      req.auth = await auth.authenticate(token);
      next();
    } catch (err) {
      if (err instanceof InvalidAccessTokenError) {
        res.set('WWW-Authenticate', 'Bearer error="invalid_token"');
        return next(httpError(401, 'invalid or revoked access token'));
      }
      next(err);
    }
  };
}

/**
 * Authorization by ROLE — 403: the caller is known (requireAuth ran first),
 * the role just isn't enough. A client SDK shows an error on 403; it must
 * not refresh, a new token carries the same role.
 *
 * The role comes from the token: a cached copy of users.role, valid until
 * exp (see README, "розжалуваний адмін").
 *
 * Ownership is deliberately NOT a guard: a guard runs before the resource
 * is loaded and has no owner to compare with. It's checked where the
 * resource is (see app.js, GET /orders/:orderId).
 */
export function requireRole(...roles: Role[]): RequestHandler {
  return (req: Request, _res: Response, next: NextFunction) => {
    if (!req.auth) return next(httpError(401, 'missing bearer token'));
    if (!roles.includes(req.auth.role)) {
      return next(httpError(403, `requires role ${roles.join(' or ')}; you are "${req.auth.role}"`));
    }
    next();
  };
}

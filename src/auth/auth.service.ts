import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { dummyHash, verifyPassword } from './password';
import { AccessTokens, InvalidAccessTokenError, isRole, type AccessClaims, type Role } from './tokens';

export interface TokenPair {
  access_token: string;
  refresh_token: string;
  token_type: 'Bearer';
  expires_in: number;
}

export interface AuthServiceOptions {
  /** HMAC key for refresh-token hashes, from the vault. */
  refreshTokenPepper: string;
  refreshTtlSeconds: number;
  /** Security events. Never receives a token — only ids (jti, family). */
  audit: (event: string, fields: Record<string, unknown>) => void;
}

/** Any refresh failure. Deliberately one class and one 401 for the client:
 *  "unknown", "expired", "revoked" and "reused" all mean "log in again". */
export class InvalidRefreshTokenError extends Error {}

/**
 * Authentication — "who is this?". Everything here produces or checks a
 * FACT: a password matched, a signature verified, a token isn't revoked.
 * Whether that user may do a particular thing is authorization, and lives
 * in the guards (middleware.ts) and the handlers, not here.
 */
export class AuthService {
  constructor(
    private readonly pool: Pool,
    private readonly tokens: AccessTokens,
    private readonly opts: AuthServiceOptions,
  ) {}

  /** HMAC-SHA256 with a pepper from the vault, not a bare SHA-256: even a
   *  leaked copy of the whole database can't be matched against tokens
   *  without the pepper, which never lives in the database. */
  private hashRefresh(token: string): string {
    return createHmac('sha256', this.opts.refreshTokenPepper).update(token).digest('hex');
  }

  async verifyCredentials(email: string, password: string): Promise<{ id: string; role: Role } | null> {
    const { rows } = await this.pool.query<{ id: string; role: string; password_hash: string | null }>(
      `SELECT id::text AS id, role, password_hash FROM users WHERE email = $1`,
      [email],
    );
    const user = rows[0];
    // same work for "no such user" as for "wrong password" (timing)
    const ok = await verifyPassword(password, user?.password_hash ?? (await dummyHash()));
    if (!user || !user.password_hash || !ok || !isRole(user.role)) return null;
    return { id: user.id, role: user.role };
  }

  /** A login starts a new family: every refresh token rotated from this
   *  one will carry the same family_id. */
  async login(email: string, password: string): Promise<TokenPair | null> {
    const user = await this.verifyCredentials(email, password);
    if (!user) return null;
    const familyId = randomUUID();
    const refreshToken = randomBytes(32).toString('base64url');
    await this.pool.query(
      `INSERT INTO refresh_tokens (family_id, user_id, token_hash, expires_at)
       VALUES ($1, $2, $3, now() + make_interval(secs => $4))`,
      [familyId, user.id, this.hashRefresh(refreshToken), this.opts.refreshTtlSeconds],
    );
    this.opts.audit('login', { user_id: user.id, family_id: familyId });
    return this.pair(user.id, user.role, familyId, refreshToken);
  }

  /**
   * Rotation with reuse detection (RFC 9700 §4.14.2), in ONE transaction:
   * the presented token's row is locked (FOR UPDATE), so two concurrent
   * refreshes with the same token serialise — the second one sees used_at
   * and is treated as the reuse it is.
   *
   * - unknown / expired / already-revoked family → 401;
   * - already USED → somebody holds a copy: revoke the whole family (the
   *   thief's current token AND the honest client's), log it, 401;
   * - otherwise → mark it used, insert its successor in the same family,
   *   COMMIT, return a new pair. The role is re-read from users here, so a
   *   demotion reaches the token at the next refresh at the latest.
   */
  async refresh(refreshToken: string): Promise<TokenPair> {
    const tokenHash = this.hashRefresh(refreshToken);
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const { rows } = await client.query<{
        id: string;
        family_id: string;
        user_id: string;
        role: string;
        expired: boolean;
        used_at: Date | null;
        revoked_at: Date | null;
      }>(
        `SELECT rt.id, rt.family_id, rt.user_id::text AS user_id, u.role,
                rt.expires_at <= now() AS expired, rt.used_at, rt.revoked_at
           FROM refresh_tokens rt
           JOIN users u ON u.id = rt.user_id
          WHERE rt.token_hash = $1
            FOR UPDATE OF rt`,
        [tokenHash],
      );
      const row = rows[0];
      if (!row || row.revoked_at || row.expired || !isRole(row.role)) {
        await client.query('ROLLBACK');
        throw new InvalidRefreshTokenError('refresh token is not valid');
      }
      if (row.used_at) {
        const revoked = await this.revokeFamily(client, row.family_id);
        await client.query('COMMIT');
        this.opts.audit('refresh_token_reuse_detected', {
          user_id: row.user_id,
          family_id: row.family_id,
          token_id: row.id,
          first_used_at: row.used_at.toISOString(),
          tokens_revoked: revoked,
        });
        throw new InvalidRefreshTokenError('refresh token is not valid');
      }

      const nextToken = randomBytes(32).toString('base64url');
      const { rows: inserted } = await client.query<{ id: string }>(
        `INSERT INTO refresh_tokens (family_id, user_id, token_hash, expires_at)
         VALUES ($1, $2, $3, now() + make_interval(secs => $4)) RETURNING id`,
        [row.family_id, row.user_id, this.hashRefresh(nextToken), this.opts.refreshTtlSeconds],
      );
      await client.query(`UPDATE refresh_tokens SET used_at = now(), replaced_by = $2 WHERE id = $1`, [
        row.id,
        inserted[0].id,
      ]);
      await client.query('COMMIT');
      return this.pair(row.user_id, row.role, row.family_id, nextToken);
    } catch (err) {
      if (!(err instanceof InvalidRefreshTokenError)) await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  }

  /**
   * Logout is TWO actions, in ONE transaction:
   * 1. revoked_at on the refresh family — the refresh token is a row, so
   *    marking it is enough;
   * 2. the access token's jti into the denylist until its exp — the access
   *    token is self-contained and would otherwise stay valid until exp.
   * Same database for both, so they commit or roll back together.
   */
  async logout(claims: AccessClaims): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await this.revokeFamily(client, claims.fid);
      await client.query(
        `INSERT INTO revoked_access_tokens (jti, user_id, expires_at)
         VALUES ($1, $2, to_timestamp($3)) ON CONFLICT (jti) DO NOTHING`,
        [claims.jti, claims.sub, claims.exp],
      );
      // the denylist's TTL: an entry is only needed until its token's exp
      await client.query(`DELETE FROM revoked_access_tokens WHERE expires_at < now()`);
      await client.query('COMMIT');
      this.opts.audit('logout', { user_id: claims.sub, family_id: claims.fid, jti: claims.jti });
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  }

  /**
   * Every authenticated request: the signature/exp check (no I/O), then ONE
   * query — is this jti denylisted, or is its whole family revoked (logout
   * elsewhere, reuse detected)? The family check is what makes a detected
   * reuse kill the access tokens too, not only the refresh tokens. This
   * query is the price of revocability: the API is no longer stateless.
   */
  async authenticate(accessToken: string): Promise<AccessClaims> {
    const claims = this.tokens.verify(accessToken);
    const { rows } = await this.pool.query<{ revoked: boolean }>(
      `SELECT EXISTS (SELECT 1 FROM revoked_access_tokens WHERE jti = $1 AND expires_at > now())
           OR EXISTS (SELECT 1 FROM refresh_tokens WHERE family_id = $2 AND revoked_at IS NOT NULL) AS revoked`,
      [claims.jti, claims.fid],
    );
    if (rows[0]?.revoked) throw new InvalidAccessTokenError('token revoked');
    return claims;
  }

  private async revokeFamily(client: PoolClient, familyId: string): Promise<number> {
    const res = await client.query(
      `UPDATE refresh_tokens SET revoked_at = now() WHERE family_id = $1 AND revoked_at IS NULL`,
      [familyId],
    );
    return res.rowCount ?? 0;
  }

  private pair(userId: string, role: Role, familyId: string, refreshToken: string): TokenPair {
    const access = this.tokens.sign(userId, role, familyId);
    return {
      access_token: access.token,
      refresh_token: refreshToken,
      token_type: 'Bearer',
      expires_in: this.tokens.ttlSeconds,
    };
  }
}

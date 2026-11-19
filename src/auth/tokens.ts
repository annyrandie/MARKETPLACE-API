import { randomUUID, type KeyObject } from 'node:crypto';
import jwt from 'jsonwebtoken';
import { Keyring } from './keys';

export type Role = 'buyer' | 'seller' | 'admin';

/** What a verified access token tells us. `role` is a COPY of users.role
 *  taken at issue time — a cache, valid until `exp`, not the truth. */
export interface AccessClaims {
  sub: string;
  role: Role;
  /** refresh-token family this access token was issued with — lets a
   *  revoked family (logout, reuse) kill its access tokens too. */
  fid: string;
  jti: string;
  exp: number;
}

export interface AccessTokenConfig {
  privateKey: KeyObject;
  kid: string;
  keyring: Keyring;
  ttlSeconds: number;
  issuer: string;
  audience: string;
}

// The allowlist. RFC 8725 §3.1: the verifier decides which algorithms it
// accepts, never the token. Without it, a token with `alg: none` or
// `alg: HS256` (HMAC'd with our PUBLIC key as the "secret") is the classic
// algorithm-confusion forgery.
export const ACCEPTED_ALGORITHMS: jwt.Algorithm[] = ['ES256'];

export class InvalidAccessTokenError extends Error {}

export class AccessTokens {
  constructor(private readonly cfg: AccessTokenConfig) {}

  get ttlSeconds(): number {
    return this.cfg.ttlSeconds;
  }

  sign(userId: string, role: Role, familyId: string): { token: string; jti: string; exp: number } {
    const jti = randomUUID();
    const token = jwt.sign({ role, fid: familyId }, this.cfg.privateKey, {
      algorithm: 'ES256',
      keyid: this.cfg.kid,
      subject: userId,
      jwtid: jti,
      expiresIn: this.cfg.ttlSeconds,
      issuer: this.cfg.issuer,
      audience: this.cfg.audience,
    });
    return { token, jti, exp: Math.floor(Date.now() / 1000) + this.cfg.ttlSeconds };
  }

  /** Signature + algorithm + exp/iss/aud — cryptographic facts only.
   *  Revocation (denylist, dead family) is AuthService's job on top. */
  verify(token: string): AccessClaims {
    // Reading the header to pick the key is fine — nothing is trusted from
    // it until verify() below checks the signature with that key.
    const header = jwt.decode(token, { complete: true })?.header;
    const key = this.cfg.keyring.get(header?.kid);
    if (!key) throw new InvalidAccessTokenError('unknown or missing kid');
    try {
      const claims = jwt.verify(token, key, {
        algorithms: ACCEPTED_ALGORITHMS,
        issuer: this.cfg.issuer,
        audience: this.cfg.audience,
        clockTolerance: 5,
      }) as jwt.JwtPayload;
      if (!claims.sub || !claims.jti || !claims.fid || !isRole(claims.role) || !claims.exp) {
        throw new InvalidAccessTokenError('missing claims');
      }
      return { sub: claims.sub, role: claims.role, fid: String(claims.fid), jti: claims.jti, exp: claims.exp };
    } catch (err) {
      if (err instanceof InvalidAccessTokenError) throw err;
      throw new InvalidAccessTokenError(err instanceof Error ? err.message : 'invalid token');
    }
  }
}

export function isRole(value: unknown): value is Role {
  return value === 'buyer' || value === 'seller' || value === 'admin';
}

import type { Pool } from 'pg';
import { AuthService } from './auth.service';
import { Keyring, fingerprint, privateKeyFromBase64, publicKeyFromBase64, type VerificationKey } from './keys';
import { AccessTokens } from './tokens';

export interface AuthEnv {
  JWT_PRIVATE_KEY: string;
  JWT_PUBLIC_KEY: string;
  JWT_KID: string;
  REFRESH_TOKEN_PEPPER: string;
  JWT_PREVIOUS_KID?: string;
  JWT_PREVIOUS_PUBLIC_KEY?: string;
}

// 10 min: short enough that a stolen access token (or a demoted admin's
// role claim) is a bounded problem even before the denylist; long enough
// not to refresh on every other request.
export const ACCESS_TTL_SECONDS = 10 * 60;
export const REFRESH_TTL_SECONDS = 14 * 24 * 60 * 60;
export const ISSUER = 'marketplace-api';
export const AUDIENCE = 'marketplace-api';

export interface BuiltAuth {
  service: AuthService;
  tokens: AccessTokens;
  /** kid + fingerprint of every key in play — for the startup log line. */
  describe(): string;
}

/** env (already zod-validated, see src/config/env.schema.js) → the wired
 *  auth layer. The private key never leaves this function as a string. */
export function buildAuth(env: AuthEnv, pool: Pool, audit: (event: string, fields: Record<string, unknown>) => void): BuiltAuth {
  const privateKey = privateKeyFromBase64(env.JWT_PRIVATE_KEY);
  const verification: VerificationKey[] = [{ kid: env.JWT_KID, key: publicKeyFromBase64(env.JWT_PUBLIC_KEY) }];
  if (env.JWT_PREVIOUS_KID && env.JWT_PREVIOUS_PUBLIC_KEY) {
    verification.push({ kid: env.JWT_PREVIOUS_KID, key: publicKeyFromBase64(env.JWT_PREVIOUS_PUBLIC_KEY) });
  }
  const keyring = new Keyring(verification);
  const tokens = new AccessTokens({
    privateKey,
    kid: env.JWT_KID,
    keyring,
    ttlSeconds: ACCESS_TTL_SECONDS,
    issuer: ISSUER,
    audience: AUDIENCE,
  });
  const service = new AuthService(pool, tokens, {
    refreshTokenPepper: env.REFRESH_TOKEN_PEPPER,
    refreshTtlSeconds: REFRESH_TTL_SECONDS,
    audit,
  });
  return {
    service,
    tokens,
    describe: () =>
      `signing kid=${env.JWT_KID} ${fingerprint(privateKey)}` +
      verification
        .slice(1)
        .map((v) => `; also verifying kid=${v.kid} ${fingerprint(v.key)}`)
        .join(''),
  };
}

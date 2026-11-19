import { createHash, createPrivateKey, createPublicKey, type KeyObject } from 'node:crypto';

/**
 * Signing keys arrive from the vault (HW #11) as BASE64-encoded PEM: a
 * multi-line PEM doesn't survive every `export`, and the classic reward is
 * `error:1E08010C:DECODER routines::unsupported` on the first signature.
 * Parsed once into KeyObjects (not PEM strings handed around).
 */
export function privateKeyFromBase64(b64: string): KeyObject {
  return createPrivateKey(Buffer.from(b64, 'base64').toString('utf8'));
}

export function publicKeyFromBase64(b64: string): KeyObject {
  return createPublicKey(Buffer.from(b64, 'base64').toString('utf8'));
}

/** ES256 = ECDSA over P-256 — anything else is a misconfiguration. */
export function assertP256(key: KeyObject, what: string): void {
  if (key.asymmetricKeyType !== 'ec' || key.asymmetricKeyDetails?.namedCurve !== 'prime256v1') {
    throw new Error(`${what} must be an EC P-256 key (ES256), got ${key.asymmetricKeyType}/${key.asymmetricKeyDetails?.namedCurve ?? '?'}`);
  }
}

/**
 * The key's identity for logs and the README: SHA-256 of the public key's
 * DER (SPKI), ssh-style. Safe to print — it identifies the key, it can't
 * be turned back into it. Dev and prod printing different fingerprints is
 * the proof the environments don't share a key.
 */
export function fingerprint(key: KeyObject): string {
  const pub = key.type === 'private' ? createPublicKey(key) : key;
  const der = pub.export({ type: 'spki', format: 'der' });
  return `SHA256:${createHash('sha256').update(der).digest('base64').replace(/=+$/, '')}`;
}

export interface VerificationKey {
  kid: string;
  key: KeyObject;
}

/**
 * kid → public key. Normally one entry. During a signing-key rotation two:
 * the new key (which signs) and the previous one (verify-only), until every
 * token the old key signed has expired — an overlap of one access-token
 * lifetime. The kid in each token's header picks the key; a token whose
 * kid isn't here is rejected.
 */
export class Keyring {
  private readonly byKid = new Map<string, KeyObject>();

  constructor(keys: VerificationKey[]) {
    for (const { kid, key } of keys) {
      assertP256(key, `public key "${kid}"`);
      this.byKid.set(kid, key);
    }
  }

  get(kid: string | undefined): KeyObject | undefined {
    return kid === undefined ? undefined : this.byKid.get(kid);
  }

  kids(): string[] {
    return [...this.byKid.keys()];
  }
}

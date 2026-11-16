import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';

// scrypt from node:crypto — memory-hard, no native dependency. N=2^15,
// r=8 → 32 MiB per hash: tens of ms per login, which is the point.
const N = 2 ** 15;
const R = 8;
const P = 1;
const KEYLEN = 32;
const MAXMEM = 64 * 1024 * 1024;

function derive(password: string, salt: Buffer, n: number, r: number, p: number): Promise<Buffer> {
  return new Promise((resolve, reject) =>
    scrypt(password, salt, KEYLEN, { N: n, r, p, maxmem: MAXMEM }, (err, key) => (err ? reject(err) : resolve(key))),
  );
}

/** `scrypt$N$r$p$<salt b64>$<hash b64>` — parameters travel with the hash,
 *  so they can be raised later without invalidating existing passwords. */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const hash = await derive(password, salt, N, R, P);
  return ['scrypt', N, R, P, salt.toString('base64'), hash.toString('base64')].join('$');
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [scheme, n, r, p, salt, hash] = stored.split('$');
  if (scheme !== 'scrypt' || !salt || !hash) return false;
  const expected = Buffer.from(hash, 'base64');
  const actual = await derive(password, Buffer.from(salt, 'base64'), Number(n), Number(r), Number(p));
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

// For an unknown e-mail we still run one scrypt against this, so "no such
// user" and "wrong password" take the same time — response timing doesn't
// tell an attacker which e-mails exist.
let dummy: Promise<string> | undefined;
export function dummyHash(): Promise<string> {
  dummy ??= hashPassword('not-a-real-password');
  return dummy;
}

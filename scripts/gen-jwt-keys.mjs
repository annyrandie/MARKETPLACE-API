#!/usr/bin/env node
// npm run keys:generate -- <env> [--rotate]
//
// Puts HW #24's signing material into this project's file-based vault
// (secrets/<env>/, gitignored — see scripts/with-secrets.sh):
//   jwt_private_key.b64   ES256 (P-256) private key, PKCS#8 PEM, base64
//   jwt_public_key.b64    its SPKI public key, PEM, base64
//   jwt_kid               the key id that goes into every token's header
//   refresh_token_pepper  HMAC key for refresh-token hashes
//
// Never overwrites existing keys. --rotate starts an overlap rotation:
// the current public key + kid move to jwt_previous_* (verify-only), a
// new pair becomes the signing key. The pepper is kept: rotating it would
// invalidate every stored refresh token at once — that's a separate,
// deliberate "log everybody out" action, not part of a key rotation.
//
// Prints fingerprints only. Key material never goes to stdout.
import { createHash, createPublicKey, generateKeyPairSync, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const envSlug = process.argv[2];
const rotate = process.argv.includes('--rotate');
if (!envSlug || !/^[a-z0-9-]+$/.test(envSlug)) {
  console.error('usage: npm run keys:generate -- <env> [--rotate]   (e.g. dev, prod)');
  process.exit(1);
}

const dir = path.resolve(import.meta.dirname, '..', 'secrets', envSlug);
const file = (name) => path.join(dir, name);
const write = (name, value) => writeFileSync(file(name), value, { mode: 0o600 });
const fingerprint = (publicPem) =>
  `SHA256:${createHash('sha256')
    .update(createPublicKey(publicPem).export({ type: 'spki', format: 'der' }))
    .digest('base64')
    .replace(/=+$/, '')}`;

mkdirSync(dir, { recursive: true, mode: 0o700 });

if (existsSync(file('jwt_private_key.b64')) && !rotate) {
  const pub = Buffer.from(readFileSync(file('jwt_public_key.b64'), 'utf8'), 'base64').toString('utf8');
  console.log(`${envSlug}: keys already exist — kid=${readFileSync(file('jwt_kid'), 'utf8').trim()} ${fingerprint(pub)}`);
  console.log('(pass --rotate to start a key rotation)');
  process.exit(0);
}

if (rotate) {
  renameSync(file('jwt_public_key.b64'), file('jwt_previous_public_key.b64'));
  renameSync(file('jwt_kid'), file('jwt_previous_kid'));
}

const { privateKey, publicKey } = generateKeyPairSync('ec', {
  namedCurve: 'P-256',
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  publicKeyEncoding: { type: 'spki', format: 'pem' },
});
const kid = `${envSlug}-${new Date().toISOString().slice(0, 10).replaceAll('-', '')}-${randomBytes(2).toString('hex')}`;
write('jwt_private_key.b64', Buffer.from(privateKey).toString('base64'));
write('jwt_public_key.b64', Buffer.from(publicKey).toString('base64'));
write('jwt_kid', kid);
if (!existsSync(file('refresh_token_pepper'))) write('refresh_token_pepper', randomBytes(32).toString('base64url'));

console.log(`${envSlug}: kid=${kid} ${fingerprint(publicKey)}${rotate ? ' (previous key kept as verify-only)' : ''}`);

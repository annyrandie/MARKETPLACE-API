// HW #24 test helpers. Every test process gets its OWN throwaway ES256 key
// pair, generated in memory and put into process.env exactly where the
// vault (scripts/with-secrets.sh) would put it — no key file, no committed
// key, nothing shared with dev or prod.
const { generateKeyPairSync, randomBytes, randomUUID } = require('node:crypto');

function useThrowawayAuthKeys() {
  const { privateKey, publicKey } = generateKeyPairSync('ec', {
    namedCurve: 'P-256',
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    publicKeyEncoding: { type: 'spki', format: 'pem' },
  });
  process.env.JWT_PRIVATE_KEY = Buffer.from(privateKey).toString('base64');
  process.env.JWT_PUBLIC_KEY = Buffer.from(publicKey).toString('base64');
  process.env.JWT_KID = 'test';
  process.env.REFRESH_TOKEN_PEPPER = randomBytes(32).toString('base64url');
}

/** An access token signed with the throwaway key, through the app's own
 *  signer — for tests that need "a valid token for user X" without going
 *  through a login (and its Redis-backed rate limiter). Its family has no
 *  refresh-token rows, so it's never "revoked". Call after
 *  useThrowawayAuthKeys() and `npm run build`. */
function signAccessToken(sub, role = 'buyer') {
  const { buildAuth } = require('../../dist/auth');
  const built = buildAuth(process.env, /* pool unused for signing */ null, () => {});
  return built.tokens.sign(String(sub), role, randomUUID()).token;
}

module.exports = { useThrowawayAuthKeys, signAccessToken };

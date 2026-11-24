// Single source of truth for configuration. Fail-fast, not fail-late: the
// process either starts with a fully valid config, or doesn't start at all —
// and says in plain language which variables are broken, before any DI/HTTP
// setup happens. `validate()` is pure (no process.exit here) so it stays
// testable and reusable; the caller (app.js) decides what to do on failure.
const crypto = require('node:crypto');
const { z } = require('zod');

// HW #24: signing material. NO defaults, on purpose — a default for a key
// IS a key hardcoded in the repo. Missing → the process refuses to start
// and names the variable. Values are base64-encoded PEM (a multi-line PEM
// doesn't survive every `export`).
const fromVault = (what) => `${what} — comes from the vault (scripts/with-secrets.sh, secrets/<env>/), never from .env`;
const base64Pem = (what) => z.string({ error: fromVault(what) }).min(1, fromVault(what));

function tryKey(parse, b64) {
  try {
    return parse(Buffer.from(b64, 'base64').toString('utf8'));
  } catch {
    return null;
  }
}

const isP256 = (key) => key.asymmetricKeyType === 'ec' && key.asymmetricKeyDetails?.namedCurve === 'prime256v1';

const envSchema = z.object({
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),

  // Password is deliberately NOT part of this URL — it lives in
  // DB_PASSWORD_FILE and is re-read on every new pg connection, so it can be
  // rotated without touching this variable or restarting the process.
  DB_URL: z.url({ protocol: /^postgres$/ }),

  DB_PASSWORD_FILE: z.string().min(1).default('secrets/db_password'),

  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),

  TIMEOUT_MS: z.coerce.number().int().positive().default(5000),

  // HW #23: two Redis instances with opposite eviction policies — never
  // one URL with a different DB index (maxmemory-policy is per process).
  // The cache box may forget (allkeys-lru); the state box holds sessions
  // and rate-limit counters, which must not be evicted (noeviction).
  REDIS_URL: z.url({ protocol: /^rediss?$/ }).default('redis://127.0.0.1:6379'),
  REDIS_QUEUE_URL: z.url({ protocol: /^rediss?$/ }).default('redis://127.0.0.1:6380'),

  // HW #24 — from the vault only (see above)
  JWT_PRIVATE_KEY: base64Pem('ES256 private key, base64 PEM (PKCS#8)'),
  JWT_PUBLIC_KEY: base64Pem('ES256 public key, base64 PEM (SPKI)'),
  JWT_KID: z.string({ error: fromVault('key id of JWT_PRIVATE_KEY') }).regex(/^[A-Za-z0-9._-]{1,64}$/),
  REFRESH_TOKEN_PEPPER: z
    .string({ error: fromVault('HMAC pepper for refresh-token hashes') })
    .min(32, 'REFRESH_TOKEN_PEPPER must be at least 32 characters'),
  // key rotation overlap: the PREVIOUS public key stays verify-only until
  // every token it signed has expired. Optional — empty outside a rotation.
  JWT_PREVIOUS_KID: z.string().optional().transform((v) => v || undefined),
  JWT_PREVIOUS_PUBLIC_KEY: z.string().optional().transform((v) => v || undefined),

  // HW #26 — object storage. The key pair = read/write on every file in
  // the bucket → vault only, no defaults. The rest are addresses.
  STORAGE_ACCESS_KEY: z.string({ error: fromVault('object-storage access key id') }).min(1, fromVault('object-storage access key id')),
  STORAGE_SECRET_KEY: z.string({ error: fromVault('object-storage secret key') }).min(1, fromVault('object-storage secret key')),
  // empty → real AWS S3 (the SDK resolves the regional endpoint itself)
  STORAGE_ENDPOINT: z.union([z.url({ protocol: /^https?$/ }), z.literal('')]).optional().transform((v) => v || undefined),
  STORAGE_REGION: z.string().min(1).default('us-east-1'),
  STORAGE_BUCKET: z.string().regex(/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/, 'not a valid S3 bucket name').default('marketplace-files'),
  // How long a presigned single-PUT URL lives. A presigned URL can't be
  // revoked, so this is the only lever: 5 min (see README, Files). The cap
  // is deliberate — a "7 days because SigV4 allows it" config is refused.
  UPLOAD_URL_TTL_SECONDS: z.coerce.number().int().min(1).max(3600).default(300),

  // HW #28 — lifecycle. WARMUP_MS: the minimum time before listen() (the
  // DB pool must connect first in any case). DRAIN_MS: after SIGTERM, how
  // long readiness stays red with the socket still open, before close().
  WARMUP_MS: z.coerce.number().int().min(0).max(60000).default(0),
  DRAIN_MS: z.coerce.number().int().min(0).max(60000).default(5000),
}).superRefine((env, ctx) => {
  // Parse the keys NOW, before anything listens: a broken key should stop
  // the process at boot, not fail the first login an hour later.
  const priv = env.JWT_PRIVATE_KEY && tryKey(crypto.createPrivateKey, env.JWT_PRIVATE_KEY);
  const pub = env.JWT_PUBLIC_KEY && tryKey(crypto.createPublicKey, env.JWT_PUBLIC_KEY);
  if (env.JWT_PRIVATE_KEY && (!priv || !isP256(priv))) {
    ctx.addIssue({ code: 'custom', path: ['JWT_PRIVATE_KEY'], message: 'not a base64-encoded EC P-256 private key PEM' });
  }
  if (env.JWT_PUBLIC_KEY && (!pub || !isP256(pub))) {
    ctx.addIssue({ code: 'custom', path: ['JWT_PUBLIC_KEY'], message: 'not a base64-encoded EC P-256 public key PEM' });
  }
  if (priv && pub && isP256(priv) && isP256(pub)) {
    const probe = Buffer.from('keypair-check');
    const sig = crypto.sign('sha256', probe, priv);
    if (!crypto.verify('sha256', probe, pub, sig)) {
      ctx.addIssue({ code: 'custom', path: ['JWT_PUBLIC_KEY'], message: 'does not match JWT_PRIVATE_KEY' });
    }
  }
  if (Boolean(env.JWT_PREVIOUS_KID) !== Boolean(env.JWT_PREVIOUS_PUBLIC_KEY)) {
    ctx.addIssue({ code: 'custom', path: ['JWT_PREVIOUS_PUBLIC_KEY'], message: 'set both JWT_PREVIOUS_KID and JWT_PREVIOUS_PUBLIC_KEY, or neither' });
  }
  if (env.JWT_PREVIOUS_PUBLIC_KEY) {
    const prev = tryKey(crypto.createPublicKey, env.JWT_PREVIOUS_PUBLIC_KEY);
    if (!prev || !isP256(prev)) {
      ctx.addIssue({ code: 'custom', path: ['JWT_PREVIOUS_PUBLIC_KEY'], message: 'not a base64-encoded EC P-256 public key PEM' });
    }
  }
});

/** @param {Record<string, unknown>} raw
 *  @returns {Readonly<z.infer<typeof envSchema>>} */
function validate(raw) {
  const parsed = envSchema.safeParse(raw);
  if (!parsed.success) {
    const lines = parsed.error.issues
      .map((issue) => `  ${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('\n');
    throw new Error(`Invalid configuration:\n${lines}\nCompare your .env with .env.example.`);
  }
  return Object.freeze(parsed.data);
}

module.exports = { envSchema, validate };

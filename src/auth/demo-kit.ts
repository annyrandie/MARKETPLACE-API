// Shared plumbing for HW #24's three demos (demo:auth / demo:reuse /
// demo:rbac). Each demo:
//  1. brings state to clean — deletes its own previous run's users (their
//     refresh tokens and denylist rows go with them, ON DELETE CASCADE);
//  2. creates its own users with known passwords;
//  3. starts the REAL app (`node app.js`) as a child process on a free
//     port — the same entry point `npm start` runs — and waits for /health;
//  4. talks to it over HTTP only;
//  5. kills it and cleans up on every exit path, so a second run never
//     meets EADDRINUSE or leftover rows.
//
// The child gets the signing keys the demo itself got from
// scripts/with-secrets.sh (or the grader's exports) — the demo never
// generates or reads key material of its own.
import { spawn, type ChildProcess } from 'node:child_process';
import { createHmac } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import type { Pool } from 'pg';
import { createDbPool } from '../events/db';
import { hashPassword } from './password';
import type { Role } from './tokens';

export interface DemoUser {
  id: string;
  email: string;
  password: string;
  role: Role;
}

export interface HttpResult<T = any> {
  status: number;
  body: T;
}

export interface AuthDemo {
  baseUrl: string;
  users: Record<string, DemoUser>;
  /** Everything the app printed — for "was the reuse logged?" checks. */
  appOutput(): string;
  call<T = any>(method: string, urlPath: string, opts?: { token?: string; body?: unknown; headers?: Record<string, string> }): Promise<HttpResult<T>>;
  login(user: DemoUser): Promise<HttpResult<{ access_token: string; refresh_token: string }>>;
  /** Clean up, print key=number lines, check the invariant, exit. */
  finish(summary: Record<string, number>, invariant: Record<string, boolean>): Promise<never>;
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address() as { port: number };
      srv.close(() => resolve(port));
    });
  });
}

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`${name} is not set — run via: bash scripts/with-secrets.sh dev <command>`);
  return v;
}

async function reset(pool: Pool, emailLike: string): Promise<void> {
  await pool.query(`DELETE FROM users WHERE email LIKE $1`, [emailLike]);
}

export async function openAuthDemo(tag: string, specs: Record<string, Role>): Promise<AuthDemo> {
  const pool = createDbPool();
  const emailLike = `auth-${tag}-%@example.test`;
  await reset(pool, emailLike);

  const runId = Date.now();
  const users: Record<string, DemoUser> = {};
  for (const [name, role] of Object.entries(specs)) {
    const email = `auth-${tag}-${name}-${runId}@example.test`;
    const password = `pw-${name}-${runId}`;
    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO users (email, full_name, balance_cents, password_hash, role)
       VALUES ($1, $2, 1000000, $3, $4) RETURNING id::text AS id`,
      [email, `Auth demo ${name}`, await hashPassword(password), role],
    );
    users[name] = { id: rows[0].id, email, password, role };
  }

  // app.js connects with DB_URL (no password in it) + a password FILE
  // (HW #11) — built here from the same DB_* the wrapper exported.
  const tmp = mkdtempSync(path.join(os.tmpdir(), `marketplace-${tag}-`));
  const passwordFile = path.join(tmp, 'db_password');
  writeFileSync(passwordFile, requireEnv('DB_PASSWORD'), { mode: 0o600 });
  const dbUrl = `postgres://${encodeURIComponent(requireEnv('DB_USER'))}@${requireEnv('DB_HOST')}:${requireEnv('DB_PORT')}/${requireEnv('DB_NAME')}`;

  const port = await freePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  let output = '';
  const child: ChildProcess = spawn(process.execPath, [path.resolve(__dirname, '..', '..', 'app.js')], {
    env: { ...process.env, DB_URL: dbUrl, DB_PASSWORD_FILE: passwordFile, PORT: String(port), LOG_LEVEL: 'info' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout!.on('data', (d) => (output += d));
  child.stderr!.on('data', (d) => (output += d));
  // whatever happens to this process, the app goes with it
  const killChild = () => child.exitCode === null && child.kill('SIGKILL');
  process.on('exit', killChild);

  let cleaned = false;
  const cleanup = async () => {
    if (cleaned) return;
    cleaned = true;
    killChild();
    await reset(pool, emailLike).catch(() => {});
    await pool.end().catch(() => {});
    rmSync(tmp, { recursive: true, force: true });
  };

  // wait for /health (the app validates config first, then listens)
  const deadline = Date.now() + 20_000;
  for (;;) {
    if (child.exitCode !== null) {
      await cleanup();
      throw new Error(`app exited with code ${child.exitCode} before becoming healthy:\n${output}`);
    }
    try {
      if ((await fetch(`${baseUrl}/health`)).ok) break;
    } catch {
      /* not listening yet */
    }
    if (Date.now() > deadline) {
      await cleanup();
      throw new Error(`app did not become healthy in 20s:\n${output}`);
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  const authLine = /auth: signing kid=\S+ SHA256:\S+/.exec(output)?.[0];
  if (authLine) console.error(authLine); // which key signed this run — fingerprint, never the key

  const call: AuthDemo['call'] = async (method, urlPath, opts = {}) => {
    const res = await fetch(baseUrl + urlPath, {
      method,
      headers: {
        ...(opts.body !== undefined ? { 'content-type': 'application/json' } : {}),
        ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {}),
        ...opts.headers,
      },
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    });
    const text = await res.text();
    let body: any = text;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      /* not JSON */
    }
    console.error(`${method} ${urlPath} → ${res.status}`);
    return { status: res.status, body };
  };

  return {
    baseUrl,
    users,
    appOutput: () => output,
    call,
    login: (user) => call('POST', '/auth/login', { body: { email: user.email, password: user.password } }),
    async finish(summary, invariant) {
      await cleanup();
      for (const [k, v] of Object.entries(summary)) console.log(`${k}=${v}`);
      const broken = Object.entries(invariant)
        .filter(([, ok]) => !ok)
        .map(([name]) => name);
      if (broken.length > 0) {
        console.error(`✗ invariant violated: ${broken.join(', ')}`);
        process.exit(1);
      }
      console.error('✓ invariant holds');
      process.exit(0);
    },
  };
}

/** The forged token: same header and signature, payload edited (role →
 *  admin). A server that only DECODES the token accepts it; one that
 *  verifies the signature can't. No key needed to make it. */
export function tamperRole(accessToken: string, role: string): string {
  const [header, payload, signature] = accessToken.split('.');
  const claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
  claims.role = role;
  return [header, Buffer.from(JSON.stringify(claims)).toString('base64url'), signature].join('.');
}

/** Same claims, re-wrapped with a different `alg` — the two classic
 *  algorithm-confusion forgeries. Only a verifier with an explicit
 *  algorithms allowlist (RFC 8725 §3.1) rejects both by construction:
 *  - none:  no signature at all;
 *  - HS256: an HMAC keyed with our PUBLIC key (which anyone may have) — a
 *    verifier that lets the token pick the algorithm would "verify" it
 *    with that same public key as the HMAC secret. */
export function forgeWithAlg(accessToken: string, alg: 'none' | 'HS256', publicKeyPem: string): string {
  const [headerB64, payload] = accessToken.split('.');
  const header = { ...JSON.parse(Buffer.from(headerB64, 'base64url').toString('utf8')), alg };
  const h = Buffer.from(JSON.stringify(header)).toString('base64url');
  if (alg === 'none') return `${h}.${payload}.`;
  const sig = createHmac('sha256', publicKeyPem).update(`${h}.${payload}`).digest('base64url');
  return `${h}.${payload}.${sig}`;
}

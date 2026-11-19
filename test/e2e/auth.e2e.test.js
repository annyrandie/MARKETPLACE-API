// E2E for HW #24's authentication in the real app (createApp(), behind the
// OpenAPI request+response validator) against a real, migrated Postgres:
// demo:reuse and demo:auth as regression tests, plus the edges the demos
// don't print (the hashed refresh token at rest, an expired access token).
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const request = require('supertest');
const jwt = require('jsonwebtoken');
const { startPg } = require('../integration/testkit/container');
const { useThrowawayAuthKeys, useDummyStorage } = require('../testkit/auth');

const PASSWORD = 'auth-e2e-password';

describe('E2E: authentication — rotation with reuse detection, logout, 401s', () => {
  let pg;
  let app;
  let passwordFile;
  let closeResources;

  beforeAll(async () => {
    pg = await startPg();
    const dbUrl = new URL(pg.uri);
    passwordFile = path.join(os.tmpdir(), `marketplace-auth-e2e-password-${Date.now()}`);
    fs.writeFileSync(passwordFile, decodeURIComponent(dbUrl.password));
    dbUrl.password = '';

    process.env.DB_URL = dbUrl.toString();
    process.env.DB_PASSWORD_FILE = passwordFile;
    process.env.LOG_LEVEL = 'error';
    // no Redis in this file: point the login rate limiter at a closed port
    // — it fails OPEN by design, so logins still go through
    process.env.REDIS_QUEUE_URL = 'redis://127.0.0.1:1';
    useThrowawayAuthKeys();
    useDummyStorage();

    ({ closeResources } = require('../../app'));
    app = require('../../app').createApp();
  }, 120000);

  afterAll(async () => {
    await closeResources();
    fs.rmSync(passwordFile, { force: true });
    await pg.stop();
  });

  async function newUser(role = 'buyer') {
    const { hashPassword } = require('../../dist/auth/password');
    const email = `auth-e2e-${Date.now()}-${Math.random().toString(36).slice(2)}@example.test`;
    const { rows } = await pg.pool.query(
      `INSERT INTO users (email, full_name, password_hash, role) VALUES ($1, 'Auth E2E', $2, $3) RETURNING id::text AS id`,
      [email, await hashPassword(PASSWORD), role],
    );
    return { id: rows[0].id, email };
  }

  const login = (user) => request(app).post('/auth/login').send({ email: user.email, password: PASSWORD });
  const refresh = (token) => request(app).post('/auth/refresh').send({ refresh_token: token });
  const me = (access) => request(app).get('/auth/me').set('Authorization', `Bearer ${access}`);

  test('login: wrong password and unknown e-mail are the same 401; the refresh token is stored only as an HMAC', async () => {
    const user = await newUser();
    const bad = await request(app).post('/auth/login').send({ email: user.email, password: 'nope' }).expect(401);
    const unknown = await request(app).post('/auth/login').send({ email: 'ghost@example.test', password: 'nope' }).expect(401);
    expect(bad.body.detail).toBe(unknown.body.detail);

    const ok = await login(user).expect(200);
    expect(ok.body).toMatchObject({ token_type: 'Bearer', expires_in: 600 });
    expect(jwt.decode(ok.body.access_token, { complete: true }).header).toMatchObject({ alg: 'ES256', kid: 'test' });

    const { rows } = await pg.pool.query(`SELECT token_hash FROM refresh_tokens WHERE user_id = $1`, [user.id]);
    expect(rows).toHaveLength(1);
    expect(rows[0].token_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(rows[0].token_hash).not.toContain(ok.body.refresh_token);
  });

  test('reuse of a rotated refresh token revokes the whole family — refresh AND access tokens', async () => {
    const user = await newUser();
    const r1 = (await login(user).expect(200)).body.refresh_token;
    const second = await refresh(r1).expect(200);
    await me(second.body.access_token).expect(200);

    await refresh(r1).expect(401); // the replay
    await refresh(second.body.refresh_token).expect(401); // the honest client is out too
    await me(second.body.access_token).expect(401);

    const { rows } = await pg.pool.query(
      `SELECT count(*)::int AS live FROM refresh_tokens WHERE user_id = $1 AND revoked_at IS NULL`,
      [user.id],
    );
    expect(rows[0].live).toBe(0);
  });

  test('logout kills both tokens; another login (another family) is unaffected', async () => {
    const user = await newUser();
    const laptop = (await login(user).expect(200)).body;
    const phone = (await login(user).expect(200)).body;

    await request(app).post('/auth/logout').set('Authorization', `Bearer ${laptop.access_token}`).expect(204);
    await me(laptop.access_token).expect(401);
    await refresh(laptop.refresh_token).expect(401);

    await me(phone.access_token).expect(200);
    await refresh(phone.refresh_token).expect(200);
  });

  test('an expired access token is 401, not 403 or 500', async () => {
    const { privateKeyFromBase64 } = require('../../dist/auth/keys');
    const expired = jwt.sign({ role: 'buyer', fid: '00000000-0000-0000-0000-000000000000' }, privateKeyFromBase64(process.env.JWT_PRIVATE_KEY), {
      algorithm: 'ES256',
      keyid: 'test',
      subject: '1',
      jwtid: '00000000-0000-0000-0000-000000000001',
      issuer: 'marketplace-api',
      audience: 'marketplace-api',
      expiresIn: -60,
    });
    await me(expired).expect(401);
  });
});

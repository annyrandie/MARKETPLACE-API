// E2E for HW #23's Redis routes in the REAL app (createApp() from app.js,
// behind the OpenAPI request AND response validator): the cached product
// card, Redis sessions and the shared rate limit. Real Postgres (the
// migrated testkit schema) and two real Redis containers with the same
// opposite eviction policies as docker-compose.yml — not mocks: what's
// under test is exactly the app ↔ Redis ↔ contract wiring.
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { GenericContainer, Wait } = require('testcontainers');
const request = require('supertest');
const { startPg } = require('../integration/testkit/container');

function startRedis(policy) {
  return new GenericContainer('redis:8.4-alpine')
    .withCommand(['redis-server', '--maxmemory', '64mb', '--maxmemory-policy', policy])
    .withExposedPorts(6379)
    .withWaitStrategy(Wait.forLogMessage('Ready to accept connections'))
    .start();
}

describe('E2E: Redis-backed routes in the real app (HW #23)', () => {
  let pg;
  let cacheBox;
  let stateBox;
  let passwordFile;
  let app;
  let closeResources;

  beforeAll(async () => {
    [pg, cacheBox, stateBox] = await Promise.all([startPg(), startRedis('allkeys-lru'), startRedis('noeviction')]);

    const dbUrl = new URL(pg.uri);
    passwordFile = path.join(os.tmpdir(), `marketplace-redis-e2e-password-${Date.now()}`);
    fs.writeFileSync(passwordFile, decodeURIComponent(dbUrl.password));
    dbUrl.password = ''; // app.js: the password comes from the file, never the URL

    // before the require: app.js validates env and builds its clients at load time
    process.env.DB_URL = dbUrl.toString();
    process.env.DB_PASSWORD_FILE = passwordFile;
    process.env.REDIS_URL = `redis://${cacheBox.getHost()}:${cacheBox.getMappedPort(6379)}`;
    process.env.REDIS_QUEUE_URL = `redis://${stateBox.getHost()}:${stateBox.getMappedPort(6379)}`;
    process.env.LOG_LEVEL = 'error';

    ({ closeResources } = require('../../app'));
    app = require('../../app').createApp();
  }, 120000);

  afterAll(async () => {
    await closeResources();
    fs.rmSync(passwordFile, { force: true });
    await Promise.all([pg.stop(), cacheBox.stop(), stateBox.stop()]);
  });

  async function insertUser(email, balanceCents = 1_000_000) {
    const { rows } = await pg.pool.query(
      `INSERT INTO users (email, full_name, balance_cents) VALUES ($1, 'Redis E2E', $2) RETURNING id::text AS id`,
      [email, balanceCents],
    );
    return rows[0].id;
  }

  async function insertProduct(stock) {
    const { rows } = await pg.pool.query(
      `INSERT INTO products (name, description, price_cents, stock) VALUES ('Redis E2E product', 'redis e2e fixture', 2500, $1) RETURNING id::text AS id`,
      [stock],
    );
    return rows[0].id;
  }

  test('GET /product-cards/:id → 200 from the DB once, then from the cache; unknown id → 404', async () => {
    const id = await insertProduct(5);

    const first = await request(app).get(`/product-cards/${id}`).expect(200);
    expect(first.body).toEqual({ id, name: 'Redis E2E product', price_cents: 2500, stock: 5, units_sold: 0, orders_count: 0 });
    expect(first.headers['ratelimit-limit']).toBe('60');

    // change the row behind the cache's back: a hit must not see it
    await pg.pool.query(`UPDATE products SET name = 'renamed' WHERE id = $1`, [id]);
    const second = await request(app).get(`/product-cards/${id}`).expect(200);
    expect(second.body.name).toBe('Redis E2E product');

    const missing = await request(app).get('/product-cards/999999999').expect(404);
    expect(missing.type).toBe('application/problem+json');
  });

  test('POST /checkout marks the card stale → the next read shows the new stock', async () => {
    const userId = await insertUser(`redis-e2e-checkout-${Date.now()}@example.test`);
    const id = await insertProduct(5);
    await request(app).get(`/product-cards/${id}`).expect(200); // warm

    await request(app)
      .post('/checkout')
      .set('Idempotency-Key', `redis-e2e-${Date.now()}`)
      .send({ user_id: userId, product_id: id, quantity: 2 })
      .expect(201);

    const after = await request(app).get(`/product-cards/${id}`).expect(200);
    expect(after.body).toMatchObject({ stock: 3, units_sold: 2, orders_count: 1 });
  });

  test('session: login → current (rolling) → logout → 401; the token never appears in a body', async () => {
    const email = `redis-e2e-session-${Date.now()}@example.test`;
    const userId = await insertUser(email);
    const agent = request.agent(app);

    const login = await agent.post('/sessions').send({ email }).expect(201);
    expect(login.body).toEqual({ user_id: userId, idle_timeout_seconds: 1800 });
    expect(login.headers['set-cookie'][0]).toMatch(/^sid=[\w-]{43}; HttpOnly; SameSite=Lax; Path=\//);

    const me = await agent.get('/sessions/current').expect(200);
    expect(me.body.user_id).toBe(userId);

    await agent.delete('/sessions/current').expect(204);
    const gone = await agent.get('/sessions/current').expect(401);
    expect(gone.type).toBe('application/problem+json');

    await request(app).get('/sessions/current').expect(401); // no cookie at all
    await request(app).get('/sessions/current').set('Cookie', 'sid=forged').expect(401);
  });

  test('unknown e-mail → 401 (not 404); 11th login attempt in a minute → 429 + Retry-After', async () => {
    // a fresh limiter bucket: other tests in this file logged in from the same IP
    await request(app).post('/sessions').send({ email: 'nobody@example.test' }).expect((res) => {
      expect([401, 429]).toContain(res.status);
    });
    const statuses = [];
    let limited;
    for (let i = 0; i < 11; i++) {
      const res = await request(app).post('/sessions').send({ email: 'nobody@example.test' });
      statuses.push(res.status);
      if (res.status === 429) limited = res;
    }
    expect(statuses.filter((s) => s === 401).length).toBeGreaterThan(0);
    expect(limited).toBeDefined();
    expect(limited.type).toBe('application/problem+json');
    expect(Number(limited.headers['retry-after'])).toBeGreaterThanOrEqual(1);
  });
});

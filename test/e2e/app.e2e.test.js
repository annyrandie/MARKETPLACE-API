// E2E: the REAL app (`createApp()` from app.js, the exact factory `npm
// start` itself calls — no provider/route substitution here), with its DB
// pointed at a testcontainer Postgres rather than whatever's in .env. This
// app's /products and /orders are in-memory by design (HW #9's own "Chosen
// variant — B" decision, see README), but since HW #24 every guarded route
// checks token revocation in Postgres — so the container gets the real
// migrations (testkit/startPg), and the process gets throwaway signing keys.
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const request = require('supertest');
const { startPg } = require('../integration/testkit/container');
const { useThrowawayAuthKeys, signAccessToken } = require('../testkit/auth');

describe('E2E: full Express app, no provider substitution, DB from testcontainer', () => {
  let pg;
  let app;
  let passwordFile;
  let closeResources;

  beforeAll(async () => {
    pg = await startPg();
    const dbUrl = new URL(pg.uri);

    passwordFile = path.join(os.tmpdir(), `marketplace-e2e-password-${Date.now()}`);
    fs.writeFileSync(passwordFile, decodeURIComponent(dbUrl.password));
    dbUrl.password = '';
    useThrowawayAuthKeys();

    // app.js validates env and builds its pg.Pool at require-time (fail-fast
    // config, see app.js's own header comment) — these MUST be set before
    // the first require() below, not after.
    process.env.DB_URL = dbUrl.toString();
    process.env.DB_PASSWORD_FILE = passwordFile;
    process.env.LOG_LEVEL = 'error';

    ({ closeResources } = require('../../app'));
    app = require('../../app').createApp();
  }, 60000);

  afterAll(async () => {
    await closeResources();
    fs.rmSync(passwordFile, { force: true });
    await pg.stop();
  });

  test('happy path: POST /products (as a seller) -> 201, then GET /products/:id -> 200 the same product', async () => {
    const created = await request(app)
      .post('/products')
      .set('Authorization', `Bearer ${signAccessToken('1', 'seller')}`)
      .send({ name: 'E2E keyboard', price_cents: 12345 })
      .expect(201);

    expect(created.body).toMatchObject({ name: 'E2E keyboard', price_cents: 12345 });
    expect(created.body.id).toEqual(expect.any(String));

    const fetched = await request(app).get(`/products/${created.body.id}`).expect(200);
    expect(fetched.body).toEqual(created.body);
  });

  test('unknown product id -> 404 problem+json, not a crash', async () => {
    const res = await request(app).get('/products/does-not-exist').expect(404);
    expect(res.type).toBe('application/problem+json');
    expect(res.body).toMatchObject({ status: 404 });
  });

  test('401 vs 403: no token -> 401, a buyer writing the catalog -> 403, a broken signature -> 401', async () => {
    const product = { name: 'E2E mouse', price_cents: 100 };
    const anon = await request(app).post('/products').send(product).expect(401);
    expect(anon.type).toBe('application/problem+json');
    expect(anon.headers['www-authenticate']).toMatch(/^Bearer/);

    const buyer = signAccessToken('2', 'buyer');
    await request(app).post('/products').set('Authorization', `Bearer ${buyer}`).send(product).expect(403);

    const [h, p, sig] = buyer.split('.');
    const flipped = `${h}.${p}.${sig.slice(0, -2)}${sig.slice(-2) === 'AA' ? 'AB' : 'AA'}`;
    await request(app).post('/products').set('Authorization', `Bearer ${flipped}`).send(product).expect(401);
  });
});

// E2E: the REAL app (`createApp()` from app.js, the exact factory `npm
// start` itself calls — no provider/route substitution here), with its DB
// pointed at a testcontainer Postgres rather than whatever's in .env. No
// migrations are run: this app's /products and /orders are in-memory by
// design (HW #9's own "Chosen variant — B" decision, see README) — the
// testcontainer exists so app.js's fail-fast config validation and its real
// `pg.Pool` (used by /health) have a real Postgres to point at, the same
// contract the app has in every other environment.
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { PostgreSqlContainer } = require('@testcontainers/postgresql');
const request = require('supertest');

describe('E2E: full Express app, no provider substitution, DB from testcontainer', () => {
  let container;
  let app;
  let passwordFile;

  beforeAll(async () => {
    container = await new PostgreSqlContainer('postgres:16-alpine').start();

    passwordFile = path.join(os.tmpdir(), `marketplace-e2e-password-${Date.now()}`);
    fs.writeFileSync(passwordFile, container.getPassword());

    // app.js validates env and builds its pg.Pool at require-time (fail-fast
    // config, see app.js's own header comment) — these MUST be set before
    // the first require() below, not after.
    process.env.DB_URL = `postgres://${container.getUsername()}@${container.getHost()}:${container.getMappedPort(5432)}/${container.getDatabase()}`;
    process.env.DB_PASSWORD_FILE = passwordFile;
    process.env.LOG_LEVEL = 'error';

    const { createApp } = require('../../app');
    app = createApp();
  }, 60000);

  afterAll(async () => {
    fs.rmSync(passwordFile, { force: true });
    await container.stop();
  });

  test('happy path: POST /products -> 201, then GET /products/:id -> 200 the same product', async () => {
    const created = await request(app)
      .post('/products')
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
});

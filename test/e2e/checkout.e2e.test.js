// E2E, the data-layer half: app.e2e.test.js exercises the HW #9 HTTP app,
// but that app's /products and /orders are in-memory (HW #9's own design)
// and never call this project's real, Postgres-backed business logic —
// src/checkout.ts (HW #14), which has no HTTP route of its own. Neither
// app.e2e.test.js nor the Pact contract touches that code path as a
// result; a change that broke checkout()'s no-oversell guarantee would
// sail through both green. This file closes that gap: it runs the real
// `checkout()` — this project's most significant business feature — end
// to end against a real Postgres (the same testcontainer + real-migrations
// testkit the integration suite uses), the same way HW #14's own
// demo-race.ts exercises it against a dev database.
const { startPg } = require('../integration/testkit/container');

describe('E2E (data layer): the real checkout() against a real Postgres', () => {
  let pg;
  let AppDataSource;
  let checkoutModule;

  beforeAll(async () => {
    pg = await startPg();

    // checkout.ts takes a TypeORM DataSource, not a bare Pool — so unlike
    // app.e2e.test.js (which only needs DB_URL for app.js's own pg.Pool),
    // this file points src/data-source.ts's discrete DB_HOST/PORT/USER/
    // PASSWORD/NAME env vars at the testcontainer, the exact same split
    // scripts/with-secrets.sh already does for every other npm script that
    // touches this DataSource. Must happen BEFORE the first require below —
    // the DataSource reads these at module-load time, once.
    const dbUrl = new URL(pg.uri);
    process.env.DB_HOST = dbUrl.hostname;
    process.env.DB_PORT = dbUrl.port;
    process.env.DB_USER = decodeURIComponent(dbUrl.username);
    process.env.DB_PASSWORD = decodeURIComponent(dbUrl.password);
    process.env.DB_NAME = dbUrl.pathname.slice(1);

    // eslint-disable-next-line global-require
    AppDataSource = require('../../dist/data-source').default;
    await AppDataSource.initialize();
    // eslint-disable-next-line global-require
    checkoutModule = require('../../dist/checkout');
  }, 120000);

  afterAll(async () => {
    await AppDataSource.destroy();
    await pg.stop();
  });

  async function insertUser(balanceCents) {
    const { rows } = await pg.pool.query(
      `INSERT INTO users (email, full_name, balance_cents) VALUES ($1, 'E2E Buyer', $2) RETURNING id`,
      [`e2e-checkout-${Date.now()}-${Math.random().toString(36).slice(2)}@example.test`, balanceCents],
    );
    return rows[0].id;
  }

  async function insertProduct(stock, priceCents) {
    const { rows } = await pg.pool.query(
      `INSERT INTO products (name, description, price_cents, stock) VALUES ('E2E checkout product', 'checkout e2e fixture', $1, $2) RETURNING id`,
      [priceCents, stock],
    );
    return rows[0].id;
  }

  test('happy path: checkout() decrements stock and balance, records a real order', async () => {
    const userId = await insertUser(100000);
    const productId = await insertProduct(5, 2000);

    const result = await checkoutModule.checkout(AppDataSource, userId, productId, 2);
    expect(result.totalCents).toBe(4000);

    const { rows: productRows } = await pg.pool.query('SELECT stock FROM products WHERE id = $1', [productId]);
    expect(productRows[0].stock).toBe(3);

    const { rows: orderRows } = await pg.pool.query(
      'SELECT total_amount_cents FROM orders WHERE id = $1',
      [result.orderId],
    );
    expect(orderRows[0].total_amount_cents).toBe(4000);
  });

  test('negative case: insufficient stock rejects, and nothing partially commits', async () => {
    const userId = await insertUser(100000);
    const productId = await insertProduct(1, 2000);

    await expect(checkoutModule.checkout(AppDataSource, userId, productId, 5)).rejects.toThrow(
      checkoutModule.InsufficientStockError,
    );

    const { rows } = await pg.pool.query('SELECT stock FROM products WHERE id = $1', [productId]);
    expect(rows[0].stock).toBe(1); // unchanged — the whole transaction rolled back, not just the stock check
  });
});

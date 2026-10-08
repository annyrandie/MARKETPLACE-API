// Same isolation strategy as user.repository.test.js — see that file's and
// README's comments. Orders/order_items have real FKs to users/products
// (HW #13's InitSchema), so every test here needs a real parent row first;
// that's what the inline `insertProduct`/UserRepository calls are for, not
// a "wall of fixtures" — just the two parent rows this table actually
// requires to exist.
const { startPg } = require('./testkit/container');
const { aUser, aProduct } = require('./testkit/builders');
const { UserRepository } = require('../../dist/repositories/user.repository');
const { OrderRepository } = require('../../dist/repositories/order.repository');

async function insertProduct(client, overrides = {}) {
  const { name, description, priceCents } = aProduct(overrides);
  const { rows } = await client.query(
    'INSERT INTO products (name, description, price_cents) VALUES ($1, $2, $3) RETURNING id, name',
    [name, description, priceCents],
  );
  return rows[0];
}

describe('OrderRepository (testcontainers postgres:16-alpine)', () => {
  let pg;
  let client;
  let repo;
  let users;

  beforeAll(async () => {
    pg = await startPg();
  }, 120000);

  afterAll(async () => {
    await pg.stop();
  });

  beforeEach(async () => {
    client = await pg.pool.connect();
    await client.query('BEGIN');
    repo = new OrderRepository(client);
    users = new UserRepository(client);
  });

  afterEach(async () => {
    await client.query('ROLLBACK');
    client.release();
  });

  test('create() + findWithItems(): JOIN resolves order_items.product_id to a real product row', async () => {
    const { email, fullName } = aUser();
    const user = await users.create(email, fullName);
    const product = await insertProduct(client, { priceCents: 500 });

    const order = await repo.create(user.id, 'completed', [
      { productId: product.id, quantity: 3, unitPriceCents: 500 },
    ]);
    expect(order.total_amount_cents).toBe(1500);

    const withItems = await repo.findWithItems(order.id);
    expect(withItems.items).toHaveLength(1);
    expect(withItems.items[0]).toMatchObject({
      product_id: product.id,
      product_name: product.name,
      quantity: 3,
      unit_price_cents: 500,
    });
  });

  test('order_item referencing a non-existent product violates the real FK (23503)', async () => {
    const { email, fullName } = aUser();
    const user = await users.create(email, fullName);

    await expect(
      repo.create(user.id, 'pending', [{ productId: '999999999', quantity: 1, unitPriceCents: 100 }]),
    ).rejects.toMatchObject({ code: '23503' });
  });

  test('totalSpentByUser() aggregates across multiple real orders', async () => {
    const { email, fullName } = aUser();
    const user = await users.create(email, fullName);
    const product = await insertProduct(client, { priceCents: 1000 });

    await repo.create(user.id, 'completed', [{ productId: product.id, quantity: 2, unitPriceCents: 1000 }]);
    await repo.create(user.id, 'completed', [{ productId: product.id, quantity: 1, unitPriceCents: 1000 }]);

    const total = await repo.totalSpentByUser(user.id);
    expect(total).toBe(3000);
  });
});

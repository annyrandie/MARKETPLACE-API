// Isolation strategy: ONE testcontainer for the whole file, one transaction
// per test (BEGIN in beforeEach, ROLLBACK in afterEach) — see README's
// "Тестування" section for why this one, over TRUNCATE or a container per
// test. UserRepository is handed the transaction's Client, not the Pool —
// exactly the seam src/repositories/queryable.ts exists for.
const { startPg } = require('./testkit/container');
const { aUser } = require('./testkit/builders');
const { UserRepository } = require('../../dist/repositories/user.repository');

describe('UserRepository (testcontainers postgres:16-alpine)', () => {
  let pg;
  let client;
  let repo;

  beforeAll(async () => {
    pg = await startPg();
  }, 120000);

  afterAll(async () => {
    await pg.stop();
  });

  beforeEach(async () => {
    client = await pg.pool.connect();
    await client.query('BEGIN');
    repo = new UserRepository(client);
  });

  afterEach(async () => {
    await client.query('ROLLBACK');
    client.release();
  });

  test('create() then findByEmail() returns the same row', async () => {
    const { email, fullName } = aUser();
    const created = await repo.create(email, fullName);

    expect(created).toMatchObject({ email, full_name: fullName, balance_cents: 0 });

    const found = await repo.findByEmail(email);
    expect(found).toMatchObject({ id: created.id, email, full_name: fullName });
  });

  test('duplicate email violates the real UNIQUE constraint (23505)', async () => {
    const { email, fullName } = aUser();
    await repo.create(email, fullName);

    await expect(repo.create(email, 'Someone Else')).rejects.toMatchObject({ code: '23505' });
  });

  test('upsertByEmail() is a real ON CONFLICT: same email twice stays one row, latest name wins', async () => {
    const { email } = aUser();
    const first = await repo.upsertByEmail(email, 'First Name');
    const second = await repo.upsertByEmail(email, 'Second Name');

    expect(first.id).toBe(second.id);
    expect(second.full_name).toBe('Second Name');

    const found = await repo.findByEmail(email);
    expect(found.full_name).toBe('Second Name');
  });
});

// E2E for HW #26's upload contract in the real app (createApp(), behind the
// OpenAPI request+response validator), against a migrated Postgres and a
// real S3-compatible store (RustFS — the same image as docker-compose.yml).
// The demos prove the three headline properties; this file pins down the
// edges they don't print: ownership, a wrong size, a lying content type,
// and a double tap with one Idempotency-Key.
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { GenericContainer, Wait } = require('testcontainers');
const request = require('supertest');
const { startPg } = require('../integration/testkit/container');
const { useThrowawayAuthKeys, signAccessToken } = require('../testkit/auth');

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(2048, 7)]);

describe('E2E: direct-to-storage uploads (HW #26)', () => {
  let pg;
  let storage;
  let passwordFile;
  let app;
  let closeResources;

  beforeAll(async () => {
    [pg, storage] = await Promise.all([
      startPg(),
      new GenericContainer('rustfs/rustfs:1.0.6')
        .withCommand(['/data'])
        .withEnvironment({ RUSTFS_ACCESS_KEY: 'e2euser', RUSTFS_SECRET_KEY: 'e2esecretpass' })
        .withTmpFs({ '/data': 'rw,size=512m,mode=1777' })
        .withExposedPorts(9000)
        .withWaitStrategy(Wait.forHttp('/health', 9000))
        .start(),
    ]);

    const dbUrl = new URL(pg.uri);
    passwordFile = path.join(os.tmpdir(), `marketplace-files-e2e-password-${Date.now()}`);
    fs.writeFileSync(passwordFile, decodeURIComponent(dbUrl.password));
    dbUrl.password = '';
    process.env.DB_URL = dbUrl.toString();
    process.env.DB_PASSWORD_FILE = passwordFile;
    process.env.LOG_LEVEL = 'error';
    process.env.STORAGE_ENDPOINT = `http://${storage.getHost()}:${storage.getMappedPort(9000)}`;
    process.env.STORAGE_ACCESS_KEY = 'e2euser';
    process.env.STORAGE_SECRET_KEY = 'e2esecretpass';
    process.env.STORAGE_BUCKET = 'e2e-files';
    useThrowawayAuthKeys();

    const { createS3, ensureBucket, storageConfigFromEnv } = require('../../dist/files/storage');
    await ensureBucket(createS3(storageConfigFromEnv()), 'e2e-files');

    ({ closeResources } = require('../../app'));
    app = require('../../app').createApp();
  }, 180000);

  afterAll(async () => {
    await closeResources();
    fs.rmSync(passwordFile, { force: true });
    await Promise.all([pg.stop(), storage.stop()]);
  });

  async function newUser() {
    const { rows } = await pg.pool.query(
      `INSERT INTO users (email, full_name) VALUES ($1, 'Files E2E') RETURNING id::text AS id`,
      [`files-e2e-${Date.now()}-${Math.random().toString(36).slice(2)}@example.test`],
    );
    return { id: rows[0].id, token: signAccessToken(rows[0].id) };
  }

  const intent = (user, body, headers = {}) =>
    request(app).post('/uploads/intent').set('Authorization', `Bearer ${user.token}`).set(headers).send(body);
  const commit = (user, fileId) =>
    request(app).post('/uploads/commit').set('Authorization', `Bearer ${user.token}`).send({ file_id: fileId });
  const put = (url, body, type = 'image/png') => fetch(url, { method: 'PUT', body, headers: { 'content-type': type } });

  test('happy path, and the owner rule: another buyer gets 403 on commit and download', async () => {
    const [owner, other] = [await newUser(), await newUser()];
    const res = await intent(owner, { filename: 'a.png', content_type: 'image/png', size: PNG.length }).expect(200);
    expect(res.body.key).toMatch(new RegExp(`^uploads/${owner.id}/[0-9a-f-]{36}\\.png$`));
    expect((await put(res.body.put.url, PNG)).status).toBe(200);

    await commit(other, res.body.file_id).expect(403);
    const done = await commit(owner, res.body.file_id).expect(200);
    expect(done.body).toMatchObject({ status: 'COMPLETED', size: PNG.length });
    await commit(owner, res.body.file_id).expect(200); // idempotent

    await request(app).get(`/files/${res.body.file_id}`).set('Authorization', `Bearer ${other.token}`).expect(403);
    const dl = await request(app).get(`/files/${res.body.file_id}`).set('Authorization', `Bearer ${owner.token}`).expect(302);
    expect(Buffer.from(await (await fetch(dl.headers.location)).arrayBuffer()).equals(PNG)).toBe(true);
  });

  test('the size is signed: PUTting a different number of bytes is refused by the storage itself', async () => {
    const user = await newUser();
    const res = await intent(user, { content_type: 'image/png', size: PNG.length }).expect(200);
    expect((await put(res.body.put.url, Buffer.concat([PNG, Buffer.alloc(10)]))).status).toBe(403);
    await commit(user, res.body.file_id).expect(409);
  });

  test('a lying content type: declared image/png, bytes are not a PNG → 422 and the object is discarded', async () => {
    const user = await newUser();
    const fake = Buffer.alloc(PNG.length, 0x41);
    const res = await intent(user, { content_type: 'image/png', size: fake.length }).expect(200);
    expect((await put(res.body.put.url, fake)).status).toBe(200);
    await commit(user, res.body.file_id).expect(422);
    await commit(user, res.body.file_id).expect(409); // gone from the storage
  });

  test('allowlist and limits: unknown type → 400 (contract), too big an image → 413', async () => {
    const user = await newUser();
    await intent(user, { content_type: 'text/html', size: 10 }).expect(400);
    await intent(user, { content_type: 'image/png', size: 11 * 1024 * 1024 }).expect(413);
  });

  test('a double tap with one Idempotency-Key is one file, not two', async () => {
    const user = await newUser();
    const body = { content_type: 'image/png', size: PNG.length };
    const [a, b] = await Promise.all([
      intent(user, body, { 'Idempotency-Key': 'tap-1' }),
      intent(user, body, { 'Idempotency-Key': 'tap-1' }),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(a.body.file_id).toBe(b.body.file_id);
    expect([a.headers['idempotency-replay'], b.headers['idempotency-replay']]).toContain('true');
    await intent(user, { ...body, size: PNG.length + 1 }, { 'Idempotency-Key': 'tap-1' }).expect(422);
  });

  test('multipart plan: computed part size, one presigned URL per part', async () => {
    const user = await newUser();
    const size = 25 * 1024 * 1024;
    const res = await intent(user, { content_type: 'application/gzip', size }).expect(200);
    expect(res.body).toMatchObject({ mode: 'multipart', part_size: 5 * 1024 * 1024, parts_count: 5 });
    expect(res.body.parts).toHaveLength(5);
    const { partSizeFor } = require('../../dist/files/upload-policy');
    expect(partSizeFor(100 * 1024 ** 3)).toBe(11 * 1024 * 1024); // 100 GiB → 11 MiB, not a hardcoded 5
    await commit(user, res.body.file_id).expect(409); // nothing uploaded yet
  });
});

require('dotenv/config');

const path = require('node:path');
const crypto = require('node:crypto');
const http = require('node:http');
const { readFile } = require('node:fs/promises');
const { STATUS_CODES } = require('node:http');
const express = require('express');
const OpenApiValidator = require('express-openapi-validator');
const { Pool } = require('pg');
const { validate } = require('./src/config/env.schema');
const { OrderEventsService } = require('./dist/realtime/order-events.service');
const { attachOrdersGateway } = require('./dist/realtime/orders.gateway');
const { createOrderEventsSseHandler } = require('./dist/realtime/orders.controller');
const { DataSource } = require('typeorm');
const AppDataSource = require('./dist/data-source').default;
const { CheckoutService } = require('./dist/checkout.service');
const { createCheckoutHandler } = require('./dist/http/checkout.handler');
const { createCacheRedis, createStateRedis } = require('./dist/redis/connections');
const { CacheAside } = require('./dist/redis/cache');
const { RedisRateLimiter } = require('./dist/redis/rate-limit');
const { RedisSessionStore, sessionMiddleware, requireSession } = require('./dist/redis/session');
const { ProductCardRepository, productCardKey } = require('./dist/repositories/product-card.repository');
const { createProductCardHandler } = require('./dist/http/product-card.handler');
const { createSessionHandlers } = require('./dist/http/session.handlers');
const { buildAuth } = require('./dist/auth');
const { requireAuth, requireRole } = require('./dist/auth/middleware');
const { createAuthHandlers } = require('./dist/http/auth.handlers');
const { createS3 } = require('./dist/files/storage');
const { FilesService } = require('./dist/files/files.service');
const { createFilesHandlers } = require('./dist/http/files.handlers');

// Fail-fast: either the process starts with a fully valid config, or it
// doesn't start at all — and says in plain language which variable is
// broken, before any server/DB setup runs at all.
let env;
try {
  env = validate(process.env);
} catch (err) {
  console.error(`✗ App is not starting — invalid configuration.\n${err.message}`);
  process.exit(1);
}

const SPEC_PATH = path.join(__dirname, 'openapi', 'openapi.yaml');
const PASSWORD_FILE = path.resolve(__dirname, env.DB_PASSWORD_FILE);

const LOG_LEVELS = ['debug', 'info', 'warn', 'error'];
function log(level, ...args) {
  if (LOG_LEVELS.indexOf(level) >= LOG_LEVELS.indexOf(env.LOG_LEVEL)) {
    console.log(`[${level}]`, ...args);
  }
}

// pg only calls an async `password` function when the connection is given
// as discrete host/port/database/user — passing `connectionString` instead
// makes it silently ignore the function and send no password at all. So
// DB_URL is parsed by hand here rather than handed to pg as-is.
const dbUrl = new URL(env.DB_URL);

// Password is a FILE, not an env var: env is read once at process start and
// "freezes", but a file can be re-read. pg calls this function on every new
// connection — old pool connections keep the old password (Postgres only
// checks it at handshake), new ones pick up whatever rotate.sh last wrote.
const pool = new Pool({
  host: dbUrl.hostname,
  port: dbUrl.port ? Number(dbUrl.port) : 5432,
  database: dbUrl.pathname.slice(1),
  user: decodeURIComponent(dbUrl.username),
  password: async () => (await readFile(PASSWORD_FILE, 'utf8')).trim(),
  connectionTimeoutMillis: env.TIMEOUT_MS,
  // HW #28: a bound on every query too — connectionTimeoutMillis only
  // covers getting a connection. Found the hard way: during a burst of pod
  // churn in kind, a warm-up `SELECT 1` hung for 24 minutes with nothing
  // to stop it, and the rollout waited on that pod the whole time.
  query_timeout: env.TIMEOUT_MS,
  max: 5,
});

// REQUIRED: when Postgres closes an idle connection (rotation, failover,
// pg_terminate_backend), the pool emits 'error'. Without this handler Node
// crashes on an unhandled 'error' event — the pool itself reopens a new one.
pool.on('error', (err) => {
  log('warn', `pool recovered from a dropped connection (${err.code}) — new connections use the current password`);
});

const products = new Map();
const orders = new Map();
const idempotencyStore = new Map(); // Idempotency-Key -> { bodyHash, status, response }

// HW #18: one event bus, two transports. Shared at module scope (same
// lifetime as `orders` above) so the SSE route in createApp() and the
// WebSocket gateway attached in createHttpServer() — two separate pieces
// of wiring — subscribe to the exact same instance, not two independent
// copies that could drift.
const orderEvents = new OrderEventsService();

// The one HTTP path into the real, Postgres-backed checkout() (HW #14).
// HW #22: checkout() writes order.placed to the outbox in its own
// transaction — this process never talks to the broker; the relay worker
// (npm run outbox:relay) does. Same DB as `pool` above (DB_URL + the rotating password
// file, not with-secrets.sh's DB_HOST/… split, which `npm start` never
// runs through) — AppDataSource's entities/logger, this process's own
// connection. Lazy: nothing connects until the first POST /checkout, so
// app.e2e.test.js and the Pact provider keep needing only what they did.
const checkoutService = new CheckoutService(
  new DataSource({
    ...AppDataSource.options,
    host: dbUrl.hostname,
    port: dbUrl.port ? Number(dbUrl.port) : 5432,
    database: dbUrl.pathname.slice(1),
    username: decodeURIComponent(dbUrl.username),
    password: async () => (await readFile(PASSWORD_FILE, 'utf8')).trim(),
    // AppDataSource's max: 30 is sized for demo:race's 60 concurrent
    // checkouts; an HTTP process needs the same order of magnitude as
    // `pool` above, not 30 extra PgBouncer clients on top of it.
    extra: { max: 5 },
  }),
);

// HW #23: the two Redis boxes, from the validated config (REDIS_URL /
// REDIS_QUEUE_URL). lazyConnect: nothing connects until a route that
// needs Redis is hit — app.e2e.test.js and the Pact provider, which never
// call those routes, keep needing only Postgres. Fail fast either way
// (connectTimeout = TIMEOUT_MS): a request mustn't hang on a dead Redis.
const redisOpts = { lazyConnect: true, connectTimeout: env.TIMEOUT_MS };
const cacheRedis = createCacheRedis(redisOpts, env.REDIS_URL);
const stateRedis = createStateRedis(redisOpts, env.REDIS_QUEUE_URL);
for (const [name, client] of [['cache', cacheRedis], ['state', stateRedis]]) {
  // without a listener ioredis prints "Unhandled error event" on every
  // reconnect attempt; the cache and limiter already degrade on their own
  client.on('error', (err) => log('warn', `[redis ${name}] ${err.message}`));
}

// HW #24: authentication. Keys come from the validated env (the vault,
// never a default) and are parsed into KeyObjects once, here. The audit
// callback gets ids only (user, family, jti) — never a token.
const auth = buildAuth(env, pool, (event, fields) =>
  log(event.endsWith('_detected') ? 'warn' : 'info', `[auth] ${JSON.stringify({ event, ...fields })}`),
);
const authenticate = requireAuth(auth.service);
const authHandlers = createAuthHandlers(auth.service);

// HW #26: object storage. The S3 client only signs and makes control-plane
// calls (create/list/complete multipart, HeadObject at commit) — the file
// BYTES never pass through this process. Credentials from the validated
// env (the vault); constructing the client opens no connection.
const s3 = createS3({
  endpoint: env.STORAGE_ENDPOINT,
  region: env.STORAGE_REGION,
  bucket: env.STORAGE_BUCKET,
  accessKeyId: env.STORAGE_ACCESS_KEY,
  secretAccessKey: env.STORAGE_SECRET_KEY,
});
const filesService = new FilesService(pool, s3, {
  bucket: env.STORAGE_BUCKET,
  putUrlTtlSeconds: env.UPLOAD_URL_TTL_SECONDS,
  audit: (event, fields) => log('info', `[files] ${JSON.stringify({ event, ...fields })}`),
});
const filesHandlers = createFilesHandlers(filesService);

const cardCache = new CacheAside(cacheRedis);
const cardRepo = new ProductCardRepository(pool);
const sessionStore = new RedisSessionStore(stateRedis);
const sessionHandlers = createSessionHandlers(sessionStore, (email, password) =>
  auth.service.verifyCredentials(email, password),
);
const withSession = sessionMiddleware(sessionStore);

// Sliding windows on the state box, shared by every instance of this app.
// Login is the tight one — the brute-force surface — keyed per (IP,
// e-mail): one account can't be hammered, and one office NAT doesn't lock
// everybody behind it out at once.
const cardLimiter = new RedisRateLimiter(stateRedis, {
  limit: 60,
  windowMs: 60_000,
  prefix: 'product-cards',
  clientId: (req) => req.ip,
});
const loginLimiter = new RedisRateLimiter(stateRedis, {
  limit: 10,
  windowMs: 60_000,
  prefix: 'login',
  clientId: (req) => `${req.ip}:${String(req.body?.email ?? '').toLowerCase()}`,
});


/** For tests/graceful shutdown: close what this module opened — Redis
 *  connections (a no-op for ones that never connected), checkout's
 *  DataSource, the pg pool. */
async function closeResources() {
  await Promise.all([cacheRedis, stateRedis].map((c) => (c.status === 'wait' ? c.disconnect() : c.quit().catch(() => {}))));
  await checkoutService.close();
  await pool.end();
}

function getOwnedOrder(orderId) {
  const order = orders.get(orderId);
  return order ? { id: order.id, userId: order.userId } : undefined;
}

// `order.userId` is this feature's own bookkeeping (HW #18) — not part of
// the documented Order schema (openapi/openapi.yaml), so every response
// strips it before serializing instead of leaking an undocumented field.
function toPublicOrder(order) {
  const { userId, ...publicOrder } = order; // eslint-disable-line no-unused-vars
  return publicOrder;
}

let nextProductSeq = 1;
let nextOrderSeq = 1;

function seedProducts() {
  for (const [name, price_cents] of [
    ['Mechanical keyboard', 249900],
    ['Wireless mouse', 89900],
    ['27" monitor', 899900],
  ]) {
    const id = `prod_${nextProductSeq++}`;
    products.set(id, { id, name, price_cents, created_at: new Date().toISOString() });
  }
}
seedProducts();

// problem+json (RFC 7807) is the single error contract of this API.
class ProblemError extends Error {
  constructor(status, detail) {
    super(detail);
    this.status = status;
  }
}

function slugify(text) {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '');
}

// Keyset pagination on (created_at, id) — not offset. An offset is a raw
// array index: an insert ahead of the current page shifts everyone after
// it, so "page 2" can silently repeat or skip a row. A keyset cursor encodes
// "the last row I saw" and asks for whatever comes strictly after it in
// (created_at, id) order, which stays correct no matter what else changed
// in the dataset — the same technique #12 needs for the real Postgres query.
function numericSuffix(id) {
  return Number(id.slice(id.lastIndexOf('_') + 1));
}

function compareByKeyset(a, b) {
  if (a.created_at !== b.created_at) return a.created_at < b.created_at ? -1 : 1;
  return numericSuffix(a.id) - numericSuffix(b.id);
}

function encodeCursor(item) {
  const key = { created_at: item.created_at, id: item.id };
  return Buffer.from(JSON.stringify(key), 'utf8').toString('base64url');
}

function decodeCursor(cursor) {
  if (cursor === undefined) return null;
  let key;
  try {
    key = JSON.parse(Buffer.from(String(cursor), 'base64url').toString('utf8'));
  } catch {
    throw new ProblemError(400, 'cursor is not a valid opaque token');
  }
  if (typeof key?.created_at !== 'string' || typeof key?.id !== 'string') {
    throw new ProblemError(400, 'cursor is not a valid opaque token');
  }
  return key;
}

// `sortedItems` must already be sorted by compareByKeyset — that invariant
// is what makes "first index past the cursor" a valid page boundary.
function paginate(sortedItems, req) {
  const limit = req.query.limit !== undefined ? Number(req.query.limit) : 20;
  const after = decodeCursor(req.query.cursor);
  const startIndex = after ? sortedItems.findIndex((item) => compareByKeyset(item, after) > 0) : 0;
  const from = startIndex === -1 ? sortedItems.length : startIndex;
  const items = sortedItems.slice(from, from + limit);
  const hasMore = from + items.length < sortedItems.length;
  const next_cursor = hasMore ? encodeCursor(items[items.length - 1]) : null;
  return { items, next_cursor };
}

// Sorts object keys before stringifying so two logically identical bodies
// hash the same regardless of key order in the JSON the client sent.
function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value && typeof value === 'object') {
    const keys = Object.keys(value).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function hashBody(body) {
  return crypto.createHash('sha256').update(stableStringify(body ?? {})).digest('hex');
}

// HW #28: lifecycle state for the probes. `draining` flips on SIGTERM:
// from that moment /readyz says "don't send me traffic" while the process
// still serves whatever arrives, until the drain window is over.
const lifecycle = { draining: false };

function createApp() {
  const app = express();

  // HW #28 — liveness: "should I be killed?". Answers from the process
  // alone — no database, no Redis: a DB outage must never make kubelet
  // restart healthy pods (that turns a partial outage into a restart loop).
  app.get('/healthz', (req, res) => res.json({ status: 'alive' }));

  // HW #28 — readiness: "may I get traffic?". Not before the warm-up
  // finished (the server doesn't even listen until then), and not once
  // SIGTERM arrived. Deliberately NOT tied to the database either: if the
  // DB is down, every pod would go unready at once and the Service would
  // have no endpoints — routes that don't need the DB would die with it.
  app.get('/readyz', (req, res) => {
    if (lifecycle.draining) return res.status(503).json({ status: 'draining' });
    res.json({ status: 'ready' });
  });

  // While draining, every response tells the client to drop the
  // keep-alive connection: its NEXT request opens a new connection, which
  // the Service routes to a pod that is still ready. Without this, a
  // client keeps reusing a socket to this pod until we close it under it.
  app.use((req, res, next) => {
    if (lifecycle.draining) res.set('Connection', 'close');
    next();
  });

  // Registered before the OpenAPI validator on purpose: /health is an
  // operational endpoint, not a business resource, so it isn't part of the
  // spec — and being first means it never reaches (and is never rejected
  // by) the validator's routing. It's also the endpoint that proves the DB
  // pool + password rotation actually work: 200 only if the query succeeds.
  app.get('/health', async (req, res) => {
    try {
      await pool.query('SELECT 1');
      res.json({ status: 'ok', uptimeSec: process.uptime() });
    } catch (err) {
      log('error', 'health check failed:', err.message);
      res.status(503).json({ status: 'error', uptimeSec: process.uptime() });
    }
  });

  // Same reason /health is registered before the validator: this is a
  // long-lived text/event-stream connection, never a single JSON response
  // to validate against a schema — express-openapi-validator has nothing
  // useful to check here. Documented in openapi/openapi.yaml anyway, for
  // discoverability, just not enforced there (see that path's own comment).
  // getOwnedOrder, not a bare existence check: the handler enforces the
  // same ownership rule the WebSocket join does. HW #24: the caller is
  // whoever the bearer token says (requireAuth), not an X-User-Id header
  // anybody could set.
  app.get('/orders/:orderId/events', authenticate, createOrderEventsSseHandler(orderEvents, getOwnedOrder));

  app.use(express.json());

  app.use(
    OpenApiValidator.middleware({
      apiSpec: SPEC_PATH,
      validateRequests: true,
      validateResponses: true,
      // HW #23: `security: sessionCookie` in the spec documents which
      // operations need a session; requireSession enforces it (presence
      // AND validity in Redis). The validator's own check would only test
      // presence, and reads req.cookies — which needs cookie-parser.
      validateSecurity: false,
    }),
  );

  app.get('/products', (req, res) => {
    const sorted = Array.from(products.values()).sort(compareByKeyset);
    res.json(paginate(sorted, req));
  });

  // HW #24, authorization by ROLE: writing the catalog is for sellers and
  // admins. A buyer is authenticated (no 401) but not allowed (403).
  app.post('/products', authenticate, requireRole('seller', 'admin'), (req, res) => {
    const id = `prod_${nextProductSeq++}`;
    const product = { id, name: req.body.name, price_cents: req.body.price_cents, created_at: new Date().toISOString() };
    products.set(id, product);
    res.status(201).json(product);
  });

  app.get('/products/:productId', (req, res, next) => {
    const product = products.get(req.params.productId);
    if (!product) {
      return next(new ProblemError(404, `Product "${req.params.productId}" was not found`));
    }
    res.json(product);
  });

  // HW #24: a list is filtered by owner in the "query" itself — the same
  // place a WHERE user_id = $sub would go — not by a guard. Admins see all.
  app.get('/orders', authenticate, (req, res) => {
    const visible = Array.from(orders.values()).filter((o) => req.auth.role === 'admin' || o.userId === req.auth.sub);
    const sorted = visible.sort(compareByKeyset);
    const page = paginate(sorted, req);
    res.json({ ...page, items: page.items.map(toPublicOrder) });
  });

  app.post('/orders', authenticate, (req, res, next) => {
    try {
      // Express (and express-openapi-validator) always lowercases header
      // names in req.headers, regardless of how the spec or the client wrote them.
      const idempotencyKey = req.headers['idempotency-key'];
      const bodyHash = hashBody(req.body);
      // HW #24: keys are scoped per buyer — two buyers' "abc" never collide,
      // and one buyer can't replay (= read) another's order through a key.
      const scopedKey = `${req.auth.sub}\u0000${idempotencyKey}`;

      const existing = idempotencyStore.get(scopedKey);
      if (existing) {
        if (existing.bodyHash !== bodyHash) {
          throw new ProblemError(
            422,
            `Idempotency-Key "${idempotencyKey}" was already used with a different request body`,
          );
        }
        res.set('Idempotency-Replay', 'true');
        return res.status(existing.status).json(existing.response);
      }

      for (const item of req.body.items) {
        if (!products.has(item.product_id)) {
          throw new ProblemError(400, `product_id "${item.product_id}" does not exist`);
        }
      }

      const total_cents = req.body.items.reduce(
        (sum, item) => sum + products.get(item.product_id).price_cents * item.quantity,
        0,
      );

      // The order's owner = the authenticated caller (HW #24). Until HW #24
      // this came from an X-User-Id header — i.e. "on behalf of whoever
      // you typed in". Ownership checks (GET /orders/:id, SSE, WebSocket
      // join) compare against this.
      const userId = req.auth.sub;

      const order = {
        id: `order_${nextOrderSeq++}`,
        status: 'created',
        items: req.body.items,
        total_cents,
        created_at: new Date().toISOString(),
        userId,
      };
      orders.set(order.id, order);
      idempotencyStore.set(scopedKey, { bodyHash, status: 201, response: toPublicOrder(order) });

      res.status(201).json(toPublicOrder(order));
    } catch (err) {
      next(err);
    }
  });

  // HW #23: a placed order changes the product's stock → its cached card
  // goes stale (served once more while one request refreshes it).
  // HW #24: the buyer is the token's subject — no longer a body field.
  app.post(
    '/checkout',
    authenticate,
    createCheckoutHandler(checkoutService, { onPlaced: (productId) => cardCache.markStale(productCardKey(productId)) }),
  );

  // HW #23: the heavy read behind cache-aside + single-flight, rate-limited.
  app.get('/product-cards/:productId', cardLimiter.middleware(), createProductCardHandler(cardCache, cardRepo));

  // HW #23: Redis sessions with a rolling TTL (sessionMiddleware renews it
  // on every request that carries the cookie).
  app.post('/sessions', loginLimiter.middleware(), sessionHandlers.login);
  app.get('/sessions/current', withSession, requireSession, sessionHandlers.current);
  app.delete('/sessions/current', withSession, requireSession, sessionHandlers.logout);

  // HW #26: the two-step upload contract, under HW #24's guard. intent →
  // the client PUTs straight to the storage → commit (HeadObject-checked).
  app.post('/uploads/intent', authenticate, filesHandlers.intent);
  app.get('/uploads/:fileId/parts', authenticate, filesHandlers.parts);
  app.post('/uploads/commit', authenticate, filesHandlers.commit);
  app.get('/files/:fileId', authenticate, filesHandlers.download);

  // HW #24: the HTTP surface of authentication.
  app.post('/auth/login', loginLimiter.middleware(), authHandlers.login);
  app.post('/auth/refresh', authHandlers.refresh);
  app.post('/auth/logout', authenticate, authHandlers.logout);
  app.get('/auth/me', authenticate, authHandlers.me);

  // HW #24, authorization by OWNERSHIP — deliberately not a guard: a guard
  // runs before the order is loaded and has no owner to compare with. The
  // check sits right after the load, on the loaded resource (with a DB it
  // would be `WHERE id = $1 AND user_id = $sub` in the query itself).
  app.get('/orders/:orderId', authenticate, (req, res, next) => {
    const order = orders.get(req.params.orderId);
    if (!order) {
      return next(new ProblemError(404, `Order "${req.params.orderId}" was not found`));
    }
    if (order.userId !== req.auth.sub && req.auth.role !== 'admin') {
      return next(new ProblemError(403, `Order "${req.params.orderId}" does not belong to the caller`));
    }
    res.json(toPublicOrder(order));
  });

  // HW #18: the "existing endpoint that changes order status" the realtime
  // layer hooks into. Emits from THIS business logic, not from a
  // controller calling the gateway/SSE transport directly — orders.gateway.ts
  // and orders.controller.ts only ever learn about a status change by
  // subscribing to orderEvents, the same as any other subscriber would.
  // HW #24: fulfilment (status changes) is staff work — sellers and admins.
  app.patch('/orders/:orderId/status', authenticate, requireRole('seller', 'admin'), (req, res, next) => {
    const order = orders.get(req.params.orderId);
    if (!order) {
      return next(new ProblemError(404, `Order "${req.params.orderId}" was not found`));
    }
    order.status = req.body.status;
    orderEvents.emitStatusChange(order.id, order.status);
    res.json(toPublicOrder(order));
  });

  // Single funnel for every error in the chain — domain, express-openapi-validator,
  // or unexpected — into problem+json.
  app.use((err, req, res, next) => { // eslint-disable-line no-unused-vars
    const status = err.status || 500;
    const title = STATUS_CODES[status] || 'Error';
    // express-openapi-validator already formats err.message as
    // "request/headers must have required property '…'" — that's what goes in detail.
    let detail = err.message || 'Unexpected error';
    // `expose`: a 5xx whose message is meant for the client (503 "cache
    // entry is being rebuilt, retry later") — not an unexpected crash.
    if (status >= 500 && !err.expose) {
      console.error('[error-filter] unhandled error:', err); // details go to the log only
      detail = 'Internal server error';
    }

    res.status(status).type('application/problem+json').json({
      type: `https://marketplace-api.local/problems/${slugify(title)}`,
      title,
      status,
      detail,
      instance: req.originalUrl,
    });
  });

  return app;
}

// HW #18: socket.io needs the raw http.Server, not the Express app —
// `app.listen(...)` (what every earlier HW used) creates one internally
// and never hands it back. Separate from createApp() on purpose: tests
// (app.e2e.test.js, Pact's verify-provider.js) pass the bare Express app
// straight to supertest/listen and have no use for a WebSocket gateway —
// this function exists only for the one real process that actually serves
// realtime traffic (`npm start`, scripts/realtime-demo.mjs's target).
function createHttpServer() {
  const app = createApp();
  const server = http.createServer(app);
  // HW #24: the handshake carries the same bearer token, verified the same
  // way (signature + revocation) as every HTTP request.
  attachOrdersGateway(server, orderEvents, getOwnedOrder, (token) => auth.service.authenticate(token));
  return server;
}

module.exports = { createApp, createHttpServer, closeResources };

/**
 * HW #28 — the warm-up BEFORE listen(): what a real service does before it
 * can take traffic (here: a DB pool that actually connects; migrations and
 * cache warming in bigger services), stretched to at least WARMUP_MS.
 * Until it's over the port isn't even open, so readiness can't pass early.
 */
async function warmUp() {
  const started = Date.now();
  for (let attempt = 1; ; attempt++) {
    try {
      // each attempt is bounded on its own as well: no startup I/O may
      // wait forever — a stuck attempt is abandoned and retried
      await Promise.race([
        pool.query('SELECT 1'),
        new Promise((_, reject) =>
          setTimeout(() => reject(Object.assign(new Error('attempt timed out'), { code: 'ETIMEDOUT' })), env.TIMEOUT_MS + 1000).unref(),
        ),
      ]);
      break;
    } catch (err) {
      log('warn', `warm-up: database not reachable yet (attempt ${attempt}: ${err.code ?? err.message}) — retrying`);
      await new Promise((r) => setTimeout(r, Math.min(1000 * attempt, 5000)));
    }
  }
  const rest = env.WARMUP_MS - (Date.now() - started);
  if (rest > 0) await new Promise((r) => setTimeout(r, rest));
  log('info', `warm-up done in ${Date.now() - started} ms`);
}

/**
 * HW #28 — graceful shutdown, in THIS order:
 *  1. readiness goes red (lifecycle.draining) — the endpoints controller
 *     takes the pod out of the Service; until that propagates, traffic
 *     still arrives and is still served (with `Connection: close`);
 *  2. wait DRAIN_MS for that to happen;
 *  3. only then close the listening socket and let in-flight requests end.
 * close() first would refuse new connections while the load balancer is
 * still sending them here. terminationGracePeriodSeconds must exceed
 * DRAIN_MS + the close, or kubelet SIGKILLs mid-drain (exit 137).
 */
function handleSigterm(server) {
  process.once('SIGTERM', () => {
    lifecycle.draining = true;
    log('info', `SIGTERM: readiness off, draining for ${env.DRAIN_MS} ms before closing the socket`);
    setTimeout(() => {
      server.close(async () => {
        await closeResources().catch(() => {});
        log('info', 'drained and closed — exiting');
        process.exit(0);
      });
      server.closeIdleConnections?.();
      // in-flight requests get a bounded tail, then we go anyway
      setTimeout(() => process.exit(0), 5000).unref();
    }, env.DRAIN_MS);
  });
}

if (require.main === module) {
  log('info', `auth: ${auth.describe()}`);
  warmUp()
    .then(() => {
      const server = createHttpServer();
      handleSigterm(server);
      server.listen(env.PORT, () => {
        log('info', `marketplace-api listening on http://localhost:${env.PORT} (WebSocket + SSE realtime enabled, rev=${process.env.REV ?? '-'})`);
      });
    })
    .catch((err) => {
      log('error', 'warm-up failed:', err.message);
      process.exit(1);
    });
}

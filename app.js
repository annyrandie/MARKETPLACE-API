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

function createApp() {
  const app = express();

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
  app.get('/orders/:orderId/events', createOrderEventsSseHandler(orderEvents, (orderId) => orders.has(orderId)));

  app.use(express.json());

  app.use(
    OpenApiValidator.middleware({
      apiSpec: SPEC_PATH,
      validateRequests: true,
      validateResponses: true,
    }),
  );

  app.get('/products', (req, res) => {
    const sorted = Array.from(products.values()).sort(compareByKeyset);
    res.json(paginate(sorted, req));
  });

  app.post('/products', (req, res) => {
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

  app.get('/orders', (req, res) => {
    const sorted = Array.from(orders.values()).sort(compareByKeyset);
    const page = paginate(sorted, req);
    res.json({ ...page, items: page.items.map(toPublicOrder) });
  });

  app.post('/orders', (req, res, next) => {
    try {
      // Express (and express-openapi-validator) always lowercases header
      // names in req.headers, regardless of how the spec or the client wrote them.
      const idempotencyKey = req.headers['idempotency-key'];
      const bodyHash = hashBody(req.body);

      const existing = idempotencyStore.get(idempotencyKey);
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

      // HW #18: an order's "owner", for the WebSocket join guard
      // (orders.gateway.ts) to check against — not part of the documented
      // request body (NewOrder has additionalProperties: false), so it
      // travels as a header instead, the same place Idempotency-Key does.
      // No X-User-Id at all just means this order has no one who can join
      // its realtime room — anonymous order creation still works exactly
      // as before this HW, same as it always has.
      const userId = req.headers['x-user-id'] || null;

      const order = {
        id: `order_${nextOrderSeq++}`,
        status: 'created',
        items: req.body.items,
        total_cents,
        created_at: new Date().toISOString(),
        userId,
      };
      orders.set(order.id, order);
      idempotencyStore.set(idempotencyKey, { bodyHash, status: 201, response: toPublicOrder(order) });

      res.status(201).json(toPublicOrder(order));
    } catch (err) {
      next(err);
    }
  });

  app.get('/orders/:orderId', (req, res, next) => {
    const order = orders.get(req.params.orderId);
    if (!order) {
      return next(new ProblemError(404, `Order "${req.params.orderId}" was not found`));
    }
    res.json(toPublicOrder(order));
  });

  // HW #18: the "existing endpoint that changes order status" the realtime
  // layer hooks into. Emits from THIS business logic, not from a
  // controller calling the gateway/SSE transport directly — orders.gateway.ts
  // and orders.controller.ts only ever learn about a status change by
  // subscribing to orderEvents, the same as any other subscriber would.
  app.patch('/orders/:orderId/status', (req, res, next) => {
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
    if (status >= 500) {
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
  attachOrdersGateway(server, orderEvents, getOwnedOrder);
  return server;
}

module.exports = { createApp, createHttpServer };

if (require.main === module) {
  createHttpServer().listen(env.PORT, () => {
    log('info', `marketplace-api listening on http://localhost:${env.PORT} (WebSocket + SSE realtime enabled)`);
  });
}

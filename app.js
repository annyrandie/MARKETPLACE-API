const path = require('node:path');
const crypto = require('node:crypto');
const { STATUS_CODES } = require('node:http');
const express = require('express');
const OpenApiValidator = require('express-openapi-validator');

const SPEC_PATH = path.join(__dirname, 'openapi', 'openapi.yaml');

const products = new Map();
const orders = new Map();
const idempotencyStore = new Map(); // Idempotency-Key -> { bodyHash, status, response }

let nextProductSeq = 1;
let nextOrderSeq = 1;

function seedProducts() {
  for (const [name, price_cents] of [
    ['Mechanical keyboard', 249900],
    ['Wireless mouse', 89900],
    ['27" monitor', 899900],
  ]) {
    const id = `prod_${nextProductSeq++}`;
    products.set(id, { id, name, price_cents });
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

// Opaque cursor = offset in base64url. The format is deliberately not part
// of the contract — clients must treat it as a token, not parse it.
function encodeCursor(offset) {
  return Buffer.from(String(offset), 'utf8').toString('base64url');
}

function decodeCursor(cursor) {
  if (cursor === undefined) return 0;
  const decoded = Number(Buffer.from(String(cursor), 'base64url').toString('utf8'));
  if (!Number.isInteger(decoded) || decoded < 0) {
    throw new ProblemError(400, 'cursor is not a valid opaque token');
  }
  return decoded;
}

function paginate(allItems, req) {
  const limit = req.query.limit !== undefined ? Number(req.query.limit) : 20;
  const offset = decodeCursor(req.query.cursor);
  const items = allItems.slice(offset, offset + limit);
  const nextOffset = offset + limit;
  const next_cursor = nextOffset < allItems.length ? encodeCursor(nextOffset) : null;
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

  app.use(express.json());

  app.use(
    OpenApiValidator.middleware({
      apiSpec: SPEC_PATH,
      validateRequests: true,
      validateResponses: true,
    }),
  );

  app.get('/products', (req, res) => {
    res.json(paginate(Array.from(products.values()), req));
  });

  app.post('/products', (req, res) => {
    const id = `prod_${nextProductSeq++}`;
    const product = { id, name: req.body.name, price_cents: req.body.price_cents };
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
    const all = Array.from(orders.values()).sort((a, b) => a.created_at.localeCompare(b.created_at));
    res.json(paginate(all, req));
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

      const order = {
        id: `order_${nextOrderSeq++}`,
        status: 'created',
        items: req.body.items,
        total_cents,
        created_at: new Date().toISOString(),
      };
      orders.set(order.id, order);
      idempotencyStore.set(idempotencyKey, { bodyHash, status: 201, response: order });

      res.status(201).json(order);
    } catch (err) {
      next(err);
    }
  });

  app.get('/orders/:orderId', (req, res, next) => {
    const order = orders.get(req.params.orderId);
    if (!order) {
      return next(new ProblemError(404, `Order "${req.params.orderId}" was not found`));
    }
    res.json(order);
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

module.exports = { createApp };

if (require.main === module) {
  const PORT = Number(process.env.PORT ?? 3000);
  createApp().listen(PORT, () => {
    console.log(`marketplace-api listening on http://localhost:${PORT}`);
  });
}

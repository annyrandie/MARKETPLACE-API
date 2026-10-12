// Consumer side of the contract (HW #16, deepening HW #9's spec). An
// imagined frontend ("marketplace-web") describes what it expects from a
// REPEATED POST /orders — a path straight out of openapi/openapi.yaml,
// exercising the Idempotency-Key replay behavior documented there (HW #9's
// own "Bonus challenge"). Pact spins up a mock server from this
// description; this test talks to THAT mock server, never the real app.
// The output, pacts/*.json, is the contract — provider verification
// (test/contract/verify-provider.js) is what makes it executable against
// the real thing.
//
// Why idempotency replay, not "a product exists": app.js's seedProducts()
// runs unconditionally on every startup, so "a product exists" is true in
// every instance of this app regardless of what any state handler does —
// a handler for it would be decorative. "An order already exists for this
// Idempotency-Key" is false by default (a fresh app's idempotencyStore
// starts empty) and only becomes true because the state handler actually
// made the first request — see provider-states.js and verify-provider.js.
//
// Runs under node's own test runner, not jest: `@pact-foundation/pact`'s
// Verifier module (pulled in even by this consumer-only import, since the
// package re-exports everything from one entry point) transitively
// requires an ESM-only `https-proxy-agent` — plain Node's require() handles
// that via its own ESM/CJS interop, but jest's module loader (with this
// project's `transform: {}`) refuses it outright. node:test sidesteps the
// whole problem instead of fighting it with an extra transform toolchain.
process.env.PACT_DO_NOT_TRACK = process.env.PACT_DO_NOT_TRACK || 'true';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { PactV3, MatchersV3 } = require('@pact-foundation/pact');
const { ORDER_ALREADY_EXISTS_FOR_KEY } = require('./provider-states');

const { like, regex } = MatchersV3;

const IDEMPOTENCY_KEY = 'contract-test-key-1';

test('Pact consumer: marketplace-web repeats an order request with the same Idempotency-Key', async () => {
  const provider = new PactV3({
    consumer: 'marketplace-web',
    provider: 'marketplace-api',
    dir: path.resolve(__dirname, '..', '..', 'pacts'),
  });

  provider
    .given(ORDER_ALREADY_EXISTS_FOR_KEY)
    .uponReceiving('a repeat of an already-processed order request')
    .withRequest({
      method: 'POST',
      path: '/orders',
      headers: {
        'Content-Type': 'application/json',
        'Idempotency-Key': IDEMPOTENCY_KEY,
      },
      body: { items: [{ product_id: 'prod_1', quantity: 1 }] },
    })
    .willRespondWith({
      status: 201,
      headers: {
        'Content-Type': regex('application/json.*', 'application/json; charset=utf-8'),
        'Idempotency-Replay': 'true',
      },
      body: {
        id: like('order_1'),
        status: like('created'),
        items: [{ product_id: 'prod_1', quantity: 1 }],
        total_cents: like(249900),
        created_at: like('2026-09-10T12:05:00.000Z'),
      },
    });

  await provider.executeTest(async (mockServer) => {
    const res = await fetch(`${mockServer.url}/orders`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Idempotency-Key': IDEMPOTENCY_KEY },
      body: JSON.stringify({ items: [{ product_id: 'prod_1', quantity: 1 }] }),
    });
    assert.equal(res.status, 201);
    assert.equal(res.headers.get('idempotency-replay'), 'true');
    const body = await res.json();
    assert.equal(typeof body.id, 'string');
  });
});

// Consumer side of the contract (HW #16, deepening HW #9's spec). An
// imagined frontend ("marketplace-web") describes what it expects from
// GET /products/{productId} — a path straight out of openapi/openapi.yaml.
// Pact spins up a mock server from this description; this test talks to
// THAT mock server, never the real app. The output, pacts/*.json, is the
// contract — provider verification (test/contract/verify-provider.js) is
// what makes it executable against the real thing.
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
const { PRODUCT_CATALOG_SEEDED } = require('./provider-states');

const { like, regex } = MatchersV3;

test('Pact consumer: marketplace-web describes GET /products/{productId}', async () => {
  const provider = new PactV3({
    consumer: 'marketplace-web',
    provider: 'marketplace-api',
    dir: path.resolve(__dirname, '..', '..', 'pacts'),
  });

  provider
    .given(PRODUCT_CATALOG_SEEDED)
    .uponReceiving('a request for the first seeded product')
    .withRequest({ method: 'GET', path: '/products/prod_1' })
    .willRespondWith({
      status: 200,
      headers: {
        'Content-Type': regex('application/json.*', 'application/json; charset=utf-8'),
      },
      body: {
        id: like('prod_1'),
        name: like('Mechanical keyboard'),
        price_cents: like(249900),
        created_at: like('2026-09-10T12:00:00.000Z'),
      },
    });

  await provider.executeTest(async (mockServer) => {
    const res = await fetch(`${mockServer.url}/products/prod_1`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(typeof body.id, 'string');
    assert.equal(typeof body.name, 'string');
  });
});

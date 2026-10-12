// Shared between consumer.pact.test.js (the `.given(...)` string) and
// verify-provider.js (the stateHandlers key) — two independent string
// literals that happened to match was a trap: rename one side without the
// other and verification starts failing with "no matching state handler"
// (or silently skipping setup) for a reason that has nothing to do with
// actual application behavior.
//
// Deliberately NOT "a product exists": app.js's seedProducts() runs
// unconditionally on every startup, before anything else — there is no way
// to observe this app in a state where it's false, so a state handler for
// it would be decorative no matter what it did (or didn't) do. Idempotency
// replay is a precondition that's actually false by default (a fresh
// app instance's idempotencyStore starts empty) and only becomes true
// because something — here, the state handler — made the first request.
const ORDER_ALREADY_EXISTS_FOR_KEY = 'an order already exists for Idempotency-Key "contract-test-key-1"';

module.exports = { ORDER_ALREADY_EXISTS_FOR_KEY };

// Shared between consumer.pact.test.js (the `.given(...)` string) and
// verify-provider.js (the stateHandlers key) — two independent string
// literals that happened to match was a trap: rename one side without the
// other and verification starts failing with "no matching state handler"
// (or silently skipping setup) for a reason that has nothing to do with
// actual application behavior.
const PRODUCT_CATALOG_SEEDED = 'the product catalog has been seeded';

module.exports = { PRODUCT_CATALOG_SEEDED };

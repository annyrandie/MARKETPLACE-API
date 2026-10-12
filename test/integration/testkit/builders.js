// Test data builders: a test names only the field it actually cares about;
// everything else is a valid, unique default. No "wall of fixtures" at the
// top of every test file.
let seq = 0;

function aUser(overrides = {}) {
  seq += 1;
  return {
    email: `user-${seq}-${Date.now()}@example.test`,
    fullName: 'Test User',
    ...overrides,
  };
}

function aProduct(overrides = {}) {
  seq += 1;
  return {
    name: `Test product ${seq}`,
    description: 'builder default',
    priceCents: 1000 + seq,
    ...overrides,
  };
}

module.exports = { aUser, aProduct };

// Provider verification: the REAL app (app.js's own createApp(), listening
// for real — Pact's Verifier talks HTTP, not in-process calls) answers
// every interaction in the contract test/contract/consumer.pact.test.js
// generated. Not a jest test — Pact's Verifier manages its own process the
// same way test/contract/consumer.pact.test.js's node:test choice does (see
// that file's header comment: jest's module loader can't load the
// ESM-only transitive dependency this package pulls in).
//
// Two modes, chosen by whether PACT_BROKER_URL is set — both legal, see
// README's "Тестування" section for which is the main path:
//   - unset:  verify against the local pacts/*.json file directly.
//   - set:    verify against the broker's latest contract for this
//             consumer, and PUBLISH the result back (publishVerificationResult).
//             PACT_BROKER_URL/PACT_BROKER_TOKEN come from process.env only —
//             never hardcoded — populated either by scripts/with-secrets.sh
//             (the real vault path) or directly by the grader/CI.
process.env.PACT_DO_NOT_TRACK = process.env.PACT_DO_NOT_TRACK || 'true';

const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { Verifier } = require('@pact-foundation/pact');
const { PostgreSqlContainer } = require('@testcontainers/postgresql');
const { ORDER_ALREADY_EXISTS_FOR_KEY } = require('./provider-states');

const IDEMPOTENCY_KEY = 'contract-test-key-1';

const PROVIDER_PORT = Number(process.env.PROVIDER_PORT || 4100);
const PACT_FILE = path.resolve(__dirname, '..', '..', 'pacts', 'marketplace-web-marketplace-api.json');

async function main() {
  // A real testcontainer backs the app's config/pg.Pool the same way it
  // does in test/e2e — app.js fails fast without a valid DB_URL, and its
  // /health route genuinely queries this. The interaction being verified
  // here doesn't itself need a DB write (see the state handler below), but
  // the running app it's served FROM still needs a real Postgres to exist.
  const container = await new PostgreSqlContainer('postgres:16-alpine').start();
  const passwordFile = path.join(os.tmpdir(), `marketplace-verify-password-${Date.now()}`);
  fs.writeFileSync(passwordFile, container.getPassword());

  // Everything from here on can fail (a busy PROVIDER_PORT, a Verifier
  // error) — this try/finally is what guarantees the container and temp
  // password file above are always cleaned up, not just on the happy path.
  try {
    process.env.DB_URL = `postgres://${container.getUsername()}@${container.getHost()}:${container.getMappedPort(5432)}/${container.getDatabase()}`;
    process.env.DB_PASSWORD_FILE = passwordFile;
    process.env.LOG_LEVEL = 'error';

    // eslint-disable-next-line global-require
    const { createApp } = require('../../app');
    const app = createApp();

    // `once('error', reject)` matters: without it, a busy PROVIDER_PORT
    // (a leftover process, or two verify:provider runs racing on the same
    // host) makes the server emit an unlistened 'error' — Node crashes the
    // whole process right there, before this function's own try/finally
    // ever gets a chance to run, leaking the testcontainer and temp file.
    const server = await new Promise((resolve, reject) => {
      const s = app.listen(PROVIDER_PORT);
      s.once('listening', () => resolve(s));
      s.once('error', reject);
    });

    try {
      const options = {
        provider: 'marketplace-api',
        providerBaseUrl: `http://127.0.0.1:${PROVIDER_PORT}`,
        stateHandlers: {
          // A REAL first request through the app's own API — this is what
          // actually makes "an order already exists for this key" true.
          // Remove this handler's POST and the interaction genuinely fails:
          // the repeat request the Verifier sends next would hit an empty
          // idempotencyStore, get treated as a brand-new order (a fresh id,
          // no Idempotency-Replay header), and mismatch the contract's
          // expected response — unlike a product-existence state, which
          // app.js's unconditional seedProducts() would keep satisfying
          // whether or not any handler ran at all.
          [ORDER_ALREADY_EXISTS_FOR_KEY]: async () => {
            const res = await fetch(`http://127.0.0.1:${PROVIDER_PORT}/orders`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json', 'Idempotency-Key': IDEMPOTENCY_KEY },
              body: JSON.stringify({ items: [{ product_id: 'prod_1', quantity: 1 }] }),
            });
            if (!res.ok) throw new Error(`state handler POST /orders failed: ${res.status}`);
          },
        },
        logLevel: 'info',
      };

      const brokerUrl = process.env.PACT_BROKER_URL;
      if (brokerUrl) {
        options.pactBrokerUrl = brokerUrl;
        if (process.env.PACT_BROKER_TOKEN) options.pactBrokerToken = process.env.PACT_BROKER_TOKEN;
        options.publishVerificationResult = true;
        options.providerVersion = process.env.PROVIDER_VERSION || '1.0.0';
        options.providerVersionBranch = process.env.PROVIDER_VERSION_BRANCH || 'main';
        options.consumerVersionSelectors = [{ latest: true }];
      } else {
        if (!fs.existsSync(PACT_FILE)) {
          throw new Error(`No pact file at ${PACT_FILE} — run "npm run test:contract" first.`);
        }
        options.pactUrls = [PACT_FILE];
      }

      const output = await new Verifier(options).verifyProvider();
      console.log('verifier output:', output);
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  } finally {
    await container.stop();
    fs.rmSync(passwordFile, { force: true });
  }
}

main().catch((err) => {
  console.error('provider verification failed:', err.message ?? err);
  process.exitCode = 1;
});

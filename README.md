# Marketplace API

Course project HW #9: a contract (`openapi/openapi.yaml`) plus a working
boundary that actually enforces it. HW #11 adds the configuration skeleton
underneath it: `process.env` → zod schema (fail-fast) → typed config → code,
and a DB password that lives in a file and rotates without a restart. See
[Configuration](#configuration) below. HW #12 adds the data layer under
*that*: schema, seed, four slow queries proven slow and then proven fixed
under real volume, and full-text search. See [Data layer](#data-layer-hw-12)
below. HW #13 turns that same design into code: TypeORM entities,
migrations (`synchronize: false`), a seed, and an N+1 caught in the query
log and fixed. See [ORM data layer](#orm-data-layer-hw-13) below. HW #14
puts real concurrency on top of it: a transactional checkout that survives
50+ simultaneous buyers without overselling, a `FOR UPDATE SKIP LOCKED`
worker pool, and a retry wrapper that catches an actual, provoked `40001`.
See [Concurrency](#concurrency-hw-14) below. HW #15 adds two production
attributes on top of all of that: a connection pooler (PgBouncer, in front
of Postgres — the app never connects directly anymore) and a backup you've
actually restored, not just produced. See
[Data layer ops](#data-layer-ops-hw-15) below. HW #16 builds a trust ladder
on top: integration tests against a real Postgres (testcontainers, not
mocks), an E2E happy path through the real app, and a Pact contract that
makes HW #9's spec executable — verified against a real broker, with
`can-i-deploy` as an actual gate. See [Testing](#testing-hw-16) below.

## Quickstart for the grader

Works on a bare `git clone` — no `.env`, no file edits.

Bring up the database:

    docker compose up -d --wait

Connect (through PgBouncer, the same path the app itself uses since HW #15):

    PGPASSWORD=admin-bootstrap-only psql -h 127.0.0.1 -p 6432 -U admin -d marketplace -c 'SELECT 1'

Direct Postgres access (bypassing the pooler — admin/debugging only):

    docker compose exec db psql -U admin -d marketplace

**Chosen variant — B: runtime validation at the boundary.**
`app.js` is an Express server where `express-openapi-validator` validates
every request and every response against `openapi/openapi.yaml`, and an
error handler translates its errors (and our own domain errors) into
`application/problem+json`. Provider verification / a Pact broker
(variant A) were deliberately skipped — for this HW both variants count
equally, and B fits better with what this same server will do in HW #12–14.

## Structure

| File / folder | Purpose |
|---|---|
| `openapi/openapi.yaml` | contract: 2 resources (`products`, `orders`), 6 operations, cursor pagination, `Idempotency-Key`, `problem+json` |
| `app.js` | Express + `express-openapi-validator` at the boundary, in-memory data, config bootstrap, `/health` |
| `src/config/env.schema.js` | zod schema for `process.env` + `validate()` |
| `scripts/check-env-example.mjs` | `npm run check:env` — syncs `.env.example` against the schema |
| `.env.example` | full variable contract; `.env` is gitignored |
| `secrets/db_password` | file-based DB secret (gitignored) |
| `rotate.sh` | rotates the DB password with the app still running |
| `scripts/up-db.sh` | brings up Postgres and aligns the role's password with the secret file |
| `docker-compose.yml` | Postgres for local runs and the rotation demo |
| `Dockerfile` + `.dockerignore` | app image with no secrets in any layer |
| `init.sql` | creates `app_user`, the role the app connects as |
| `db/schema.sql` | 4 tables, 3 FKs, `numeric` for money, generated `tsvector` column |
| `db/seed.sql` | ≥100k skewed rows per table that needs it, ends in `VACUUM (ANALYZE)` |
| `db/queries/q1–q4.sql` | one real slow query each, one statement per file |
| `db/indexes.sql` | the minimal index set that fixes q1–q4, plus 2 FK-support indexes for `order_items` — see below |
| `db/OPTIMIZATIONS.md` | EXPLAIN before/after for all four + morphology + tsvector cost + the FK-index tradeoff |
| `src/entities/` | TypeORM entities for the HW #12 schema — columns, relations, `onDelete` |
| `src/data-source.ts` | `DataSource` (`synchronize: false`) + `QueryCountLogger` — no hardcoded creds |
| `src/migrations/` | the generated (and hand-fixed) initial migration |
| `src/seed.ts` | deterministic, idempotent seed for the TypeORM-managed schema |
| `src/demo-nplus1.ts` | N+1 on `order → items → product`, query counts before/after |
| `src/report.ts` | revenue-by-product via `createQueryBuilder().getRawMany()` |
| `scripts/with-secrets.sh` | resolves DB credentials from the HW #11 vault, `exec`s the wrapped command |
| `src/checkout.ts` | transactional checkout: atomic stock/balance decrement, order, queued task |
| `src/entities/task.entity.ts` | `job_queue` — durable task queue drained via `FOR UPDATE SKIP LOCKED` |
| `src/migrations/…-CheckoutConcurrency.ts` | adds `stock`, `balance_cents`, `job_queue` |
| `src/lib/concurrency.ts` | `withRetry` — retries only `40001`/`40P01`, capped backoff |
| `src/demo-race.ts` | 60 concurrent `checkout()` calls, proves no oversell |
| `src/demo-workers.ts` | worker pool drains a task batch via SKIP LOCKED |
| `src/demo-retry.ts` | provokes a real `40001`, proves the retry recovers without a lost update |
| `pgbouncer/pgbouncer.ini` | `pool_mode = transaction`, `default_pool_size`, admin console config |
| `pgbouncer/userlist.txt` | client credentials PgBouncer authenticates against (same dev creds as `docker-compose.yml`/`init.sql`, no new secret) |
| `scripts/backup.sh` | `pg_dump -Fc`, dated filename, run inside the `db` container (not through the pooler — see below) |
| `scripts/restore-drill.sh` | restores the latest dump into a disposable clean container, proves a checksum match, self-cleans |
| `backup.cron` | nightly schedule line for `scripts/backup.sh` |
| `RESTORE-DRILL.md` | one real drill's record: date, dump size, restore time, RTO/RPO |
| `src/repositories/*.ts` | `UserRepository`/`OrderRepository` — accept a bare `Queryable` (Pool or a transaction-scoped Client), not TypeORM's own Repository |
| `test/integration/testkit/container.js` | starts a real `postgres:16-alpine`, builds its schema from the actual `src/migrations/*.ts` |
| `test/integration/testkit/builders.js` | `aUser()`/`aProduct()` — unique, valid defaults |
| `test/integration/*.test.js` | repository tests: unique/FK constraint, JOIN, aggregation, `ON CONFLICT` |
| `test/e2e/app.e2e.test.js` | supertest against the real `createApp()`, DB from a testcontainer |
| `test/contract/consumer.pact.test.js` | Pact consumer test → `pacts/*.json` (gitignored, regenerated on demand) |
| `test/contract/verify-provider.js` | provider verification — local `pacts/*.json` or the broker, chosen by `PACT_BROKER_URL` |
| `jest.config.js` / `jest.integration.config.js` / `jest.e2e.config.js` | shared `reporters: ['default']` base + per-suite `testMatch`/`testTimeout` |
| `.github/workflows/contract.yml` | CI `contract` job: publish → verify (`publishVerificationResult`) → tag → `can-i-deploy` |
| `README.md` | this file |

## Resources and operations in the spec

| Method | Path | operationId | Purpose |
|---|---|---|---|
| GET | `/products` | `listProducts` | list products, cursor pagination |
| POST | `/products` | `createProduct` | add a product |
| GET | `/products/{productId}` | `getProduct` | one product |
| GET | `/orders` | `listOrders` | list orders, cursor pagination |
| POST | `/orders` | `createOrder` | place an order, `Idempotency-Key` required |
| GET | `/orders/{orderId}` | `getOrder` | one order |

All six are implemented (in-memory); the catalog is seeded with three
products (`prod_1`, `prod_2`, `prod_3`) on startup.

## Run

```bash
npm install
cp .env.example .env      # first time only — fill in real-looking local values
npm run db:up              # starts Postgres (docker compose) on :5433
npm start                   # starts the server on :3000, catalog seeded with three products
```

`npm start` validates the config and exits immediately (non-zero) if it's
broken — it does **not** require Postgres to be reachable to boot (the
schema only checks that `DB_URL` is a well-formed `postgres://` URL, not
that anything is listening on it). Only `/health` — and, later, any
DB-backed route — needs Postgres actually up.

## Configuration

### Variables

All of them are validated by one zod schema (`src/config/env.schema.js`) at
process start — see [Fail-fast](#fail-fast-not-fail-late) below. The rest of
the code reads a single typed, frozen `env` object; nothing else in `app.js`
touches `process.env` directly.

| Variable | Required | Default | Source | Purpose |
|---|---|---|---|---|
| `PORT` | no | `3000` | `.env.example` | HTTP server port |
| `DB_URL` | **yes** | — | **secret store** — `.env` locally (HW #11), a secrets manager in prod; `.env.example` only holds the fake local-dev shape | Postgres connection string, **without** a password (`postgres://app_user@127.0.0.1:5433/marketplace`) |
| `DB_PASSWORD_FILE` | no | `secrets/db_password` | `.env.example` | path to the file holding the current DB password |
| `LOG_LEVEL` | no | `info` | `.env.example` | `debug` \| `info` \| `warn` \| `error` |
| `TIMEOUT_MS` | no | `5000` | `.env.example` | Postgres connection timeout, ms |

The DB password is deliberately **not** one of these variables — see
[Secrets](#secrets) below for why.

### Fail-fast, not fail-late

`src/config/env.schema.js` exports a pure `validate(raw)` — it throws with
every broken variable listed, it never calls `process.exit` itself. `app.js`
calls it once, at the very top, before the Express app, the DB pool, or
anything else exists:

```js
try {
  env = validate(process.env);
} catch (err) {
  console.error(`✗ App is not starting — invalid configuration.\n${err.message}`);
  process.exit(1);
}
```

A broken/missing variable kills the process at boot with a readable message
— not on the first request that happens to touch it in production.

```bash
env -u DB_URL npm run start
# ✗ App is not starting — invalid configuration.
# Invalid configuration:
#   DB_URL: Invalid input: expected string, received undefined
# Compare your .env with .env.example.
echo $?   # 1
```

### `.env.example` stays honest

`npm run check:env` compares `.env.example`'s variable names against the
schema's keys in both directions — missing *or* extra — and fails CI the
moment they drift apart:

```bash
npm run check:env
# ✓ .env.example is in sync with the schema (5 variables)
```

### Secrets

- **`.env` is gitignored** (`git check-ignore .env` → `.env`; `git ls-files | grep '\.env'` → only `.env.example`). Real values never leave your machine.
- **The DB password is a *file*, not an env var.** `secrets/db_password` is
  gitignored too. `app.js` passes `password: async () => (await
  readFile(...)).trim()` to `pg.Pool` — pg calls this function on **every
  new connection**, so the password can change without restarting the
  process. (This only works with discrete `host`/`port`/`database`/`user`
  fields — `pg` silently ignores an async `password` function if you also
  pass `connectionString`, which is why `app.js` parses `DB_URL` by hand
  instead of handing it straight to `Pool`.)
- **Nothing secret is in the image.** `.dockerignore` excludes `.env` and
  `secrets/`; the `Dockerfile` has no `ENV` with a real value and no `RUN`
  that touches a secret. Verify after `docker build -t myapp .`:

  ```bash
  docker run --rm myapp ls -a /app                        # .env.example, no .env, no secrets/
  docker run --rm myapp sh -c 'cat /app/.env' 2>&1         # No such file or directory
  docker inspect --format '{{.Config.Env}}' myapp          # only base-image vars
  docker history --no-trunc myapp | grep -i password       # empty
  ```

### Rotating the DB password without a restart

```bash
npm run db:up            # Postgres up, secrets/db_password prepared and aligned
npm start                 # in another terminal
curl -s localhost:3000/health   # {"status":"ok","uptimeSec":...} — note the uptime
npm run db:rotate         # = bash rotate.sh
curl -s localhost:3000/health   # still "ok", uptimeSec is HIGHER — same process
```

`rotate.sh`, in order: `ALTER ROLE app_user` in Postgres → overwrite
`secrets/db_password` → `pg_terminate_backend` on `app_user`'s existing
connections. The pool's `'error'` listener absorbs the connections that just
got killed (Postgres emits that as an admin-shutdown error, not a crash) and
reopens new ones — which read the now-current password from the file.

If you ever run `docker compose down -v` (drops the Postgres volume, so it
reinitializes with `init.sql`'s original password) while
`secrets/db_password` still holds a rotated value, just re-run
`npm run db:up` — it re-aligns the role's password with whatever the file
currently has, in either direction, so you never have to remember which one
is stale.

### Bonus challenge — not attempted

Infisical wasn't set up for this HW; the file-based secret above is where
this submission stops.

## Data layer (HW #12)

**Main table:** `orders` (≥100 000 rows). **Table `q4` searches:** `products`
(also ≥100 000 rows — two different tables, so both counts apply
separately). Same Postgres as HW #11 — `db/`, `init.sql`, and
`docker-compose.yml`'s `db` service are the one and only database; `DB_URL`
in `.env` already points at it (`postgres://app_user@127.0.0.1:5433/marketplace`),
so there's no second connection string and no new env file for this HW.

Full pipeline, in the order the grader runs it (`db/` is mounted read-only
into the container at `/db`):

```bash
docker compose up -d --wait

docker compose exec -T db psql -U admin -d marketplace -v ON_ERROR_STOP=1 -f /db/schema.sql
docker compose exec -T db psql -U admin -d marketplace -v ON_ERROR_STOP=1 -f /db/seed.sql

# before indexes — every one of these four shows a Seq Scan
for q in q1 q2 q3 q4; do
  docker compose exec -T db psql -U admin -d marketplace \
    -c "EXPLAIN (ANALYZE, BUFFERS) $(cat db/queries/$q.sql)"
done

docker compose exec -T db psql -U admin -d marketplace -v ON_ERROR_STOP=1 -f /db/indexes.sql
docker compose exec -T db psql -U admin -d marketplace -c "ANALYZE;"

# after indexes — no Seq Scan; q4 is cold on its first run, run it 2–3×
# and read the last one
for q in q1 q2 q3 q4; do
  docker compose exec -T db psql -U admin -d marketplace \
    -c "EXPLAIN (ANALYZE, BUFFERS) $(cat db/queries/$q.sql)"
done
```

Full before/after `EXPLAIN` output for all four queries, the index
inventory (with sizes and why each is partial/expression/GIN), the
morphology finding, and the measured cost of the generated `search_vector`
column all live in **`db/OPTIMIZATIONS.md`** — that file is the actual
report; this section is just how to reproduce it.

`db/indexes.sql` also creates two indexes q1–q4 never touch —
`idx_order_items_order_id` and `idx_order_items_product_id`. They exist for
`DELETE`/FK-check performance, not for any of the four graded queries
(`db/OPTIMIZATIONS.md` § FK support indexes has the real before/after and
says plainly that this repo's own dead-index check will list them if you
run only the q1–q4 pipeline — a named, deliberate exception, not an
oversight).

**Credentials, on purpose two different ones:** `admin` /
`admin-bootstrap-only` (hardcoded in `docker-compose.yml`, not a secret) is
what every command above uses — it's how anyone with a bare clone gets in,
including the grader. `app_user`, authenticated via the rotating
`secrets/db_password` file, is what `app.js` connects as — that credential
is deliberately not reachable from a fresh clone (see
[Secrets](#secrets) above). Two paths for two different consumers.

## ORM data layer (HW #13)

The HW #12 schema, now as code: `src/entities/` (TypeORM entities),
`src/migrations/` (migrations, `synchronize: false` always), `src/seed.ts`
(deterministic, idempotent), `src/demo-nplus1.ts` (N+1, caught and fixed),
`src/report.ts` (an aggregate query `find()` can't express). This is a
**separate, parallel** implementation of the same design, not a replacement
for `db/schema.sql` — the migration below creates its own tables from
scratch on a clean database; it never touches or reuses HW #12's raw-SQL
artifact.

## Grading

```bash
docker compose up -d --wait
npm run build

export DB_HOST=127.0.0.1 DB_PORT=6432 DB_USER=admin DB_PASSWORD=admin-bootstrap-only DB_NAME=marketplace
export SKIP_VAULT=1    # у грейдера немає доступу до сховища

npm run migrate
npm run migrate:show
npm run seed
npm run demo:nplus1
npm run report

# HW #14 — concurrency
npm run demo:race
npm run demo:workers
npm run demo:retry

# HW #15 — PgBouncer liveness + pool mode
psql -h 127.0.0.1 -p 6432 -U app_user -d marketplace -c "SELECT 1"       # PGPASSWORD=marketplace-v1-password
grep -E '^\s*pool_mode\s*=\s*transaction' pgbouncer/pgbouncer.ini
psql -h 127.0.0.1 -p 6432 -U admin -d pgbouncer -c "SHOW POOLS"          # PGPASSWORD=admin-bootstrap-only

# HW #15 — backup + restore drill
bash scripts/with-secrets.sh dev bash scripts/backup.sh
bash scripts/with-secrets.sh dev bash scripts/restore-drill.sh
grep -cE '^(@(reboot|yearly|annually|monthly|weekly|daily|midnight|hourly)|([0-9*/,-]+[[:space:]]+){4}[0-9*/,-]+)[[:space:]]+.*backup' backup.cron

# HW #16 — testcontainers / E2E / Pact (see Testing below for the broker walkthrough)
npx tsc --noEmit
npm run test:integration
npm run test:integration   # again — proves isolation, no manual cleanup
npm run test:e2e
npm run test:contract
npm run verify:provider
```

(Port `6432`, not `5433` — every one of the commands above (`migrate`
through `demo:retry` included) now goes through **PgBouncer**, not directly
to Postgres; `6432` is PgBouncer's published host port in this repo's
`docker-compose.yml`, unchanged in spirit from HW #11/#12's direct-port
convention, just aimed at the pooler since HW #15. Postgres's own port
(`5433`) is still published too, for direct/admin access — see
[Data layer ops](#data-layer-ops-hw-15). `admin` / `admin-bootstrap-only`
and `app_user` / `marketplace-v1-password` are the same non-secret dev
credentials already hardcoded in `docker-compose.yml` / `init.sql`; PgBouncer
authenticates against copies of the same values in `pgbouncer/userlist.txt`
— see that file's own header comment for why plaintext there is fine.)

### Why `scripts/with-secrets.sh` doesn't call Infisical

HW #11's Infisical bonus was never attempted in this project. What HW #11
*did* build is a real, working secret store — file-based:
`secrets/db_password` (gitignored, rotates without a restart — see
[Secrets](#secrets)) plus the connection shape in `.env`'s `DB_URL`
(deliberately password-less). `scripts/with-secrets.sh` plays the exact
role an `infisical run` wrapper would: resolve secrets, export them as env
vars, `exec` the wrapped command — same contract, same
`SKIP_VAULT=1 → exec "$@"` escape hatch inserted at the position the
assignment specifies, different backing store. Every npm script that
touches the database (`migrate`, `migrate:show`, `migrate:revert`,
`migrate:generate`, `seed`, `demo:nplus1`, `report`) is wrapped, so they're
called unprefixed — `npm run migrate`, not
`bash scripts/with-secrets.sh dev npm run migrate`.

One real, load-bearing fix this required: `app_user` (the role the vault
path connects as) could `CONNECT` but, on Postgres 16, could not
`CREATE TABLE` — Postgres 15+ stopped granting `CREATE` on the `public`
schema to `PUBLIC` by default. `npm run migrate` through the actual vault
path failed with `permission denied for schema public` until `init.sql`
got one added line: `GRANT CREATE ON SCHEMA public TO app_user;`. Caught by
actually running the vault path locally, not assumed to work.

### N+1 — proven, then fixed, on `order → items → product` (two relation levels)

`npm run demo:nplus1`, measured with the SQL query logger
(`QueryCountLogger` in `src/data-source.ts` — the only tool that actually
shows N+1; it's invisible in the TypeScript):

| Strategy | Queries (10 orders) | Queries (100 orders) |
|---|---|---|
| Naive — `find()` + a query per order for its items, + a query per item for its product | 51 | 321 |
| `relations: { items: { product: true } }` (LEFT JOIN) | 1 | 1 |
| `relationLoadStrategy: 'query'` (no JOIN, still not N+1) | 5 | 5 |

The naive count **grows with N** (51 → 321 going from 10 to 100 orders,
confirmed by actually reseeding 90 extra orders and rerunning, not just
asserted); the query-strategy count is a **constant** — `1 + 2×levels`
with 2 relation levels (`items`, then `items.product`) is `1 + 2×2 = 5`,
matching the assignment's own formula exactly. `relations` alone (a single
LEFT JOIN) beats both when row multiplication isn't a concern; `query`
strategy earns its keep when a JOIN would multiply rows badly (one order ×
many items).

### Repository vs QueryBuilder

`find()`/`Repository` covers "give me entities that exist, optionally with
their relations" — CRUD and graph loading, the large majority of this
project's actual queries (seed, N+1 demo, anything shaped like "get me an
`Order` and its stuff"). The line gets crossed the moment the result isn't
an entity anymore — an aggregate, a `GROUP BY`, a computed column across a
join (`src/report.ts`'s revenue-by-product: `SUM(...)`, `GROUP BY p.id`,
raw rows back, not `Product` instances). `find()` has no vocabulary for
that at all; `createQueryBuilder().getRawMany()` is the only correct tool,
not a stylistic alternative.

Worth getting right even inside the QueryBuilder version: the report
`leftJoin`s `order_items` and wraps both aggregates in `COALESCE(..., 0)`,
not `innerJoin` + bare `SUM`. A product with zero sales has to show up as a
`0` row — `innerJoin` would drop it from the result set entirely, which
reads as "this product doesn't exist" to anyone consuming the report, not
"exists, sold nothing".

### `onDelete` choices

Two distinct strategies, three FKs, each a deliberate call:

- `OrderItem.order` → `orders` — **CASCADE**. A deleted order's line items
  describe nothing on their own; they have no independent meaning.
- `OrderItem.product` → `products` — **RESTRICT**. A product referenced by
  real sales history must not disappear out from under it.
- `Order.user` → `users` — **RESTRICT**. Order history must survive even if
  the placing user's account is later deleted — the same "history over
  convenience" call `db/schema.sql` (HW #12) makes structurally by leaving
  that FK's `ON DELETE` unspecified (Postgres's default, `NO ACTION`,
  behaves like `RESTRICT` here).

### Two decisions worth naming explicitly

- **Money: `integer` minor units here, `numeric(10,2)` in `db/schema.sql`.**
  Two different, both legitimate choices in two parallel artifacts of the
  same design — `numeric` is exact decimal (not float, HW #12's own
  instruction), integer cents is *this* HW's own explicit instruction.
  Neither is wrong; they just don't have to match byte-for-byte since this
  ORM layer builds its own schema from scratch rather than reusing #12's.
- **`search_vector` needed hand-editing the generated migration.**
  `migration:generate` has no idea a `tsvector` column is supposed to be a
  Postgres `GENERATED ALWAYS AS (...) STORED` expression — TypeORM's
  `@Column` decorator can't express that. The entity declares the column
  read-only (`select/insert/update: false`); the actual `GENERATED ALWAYS
  AS (to_tsvector('simple', name || ' ' || description)) STORED` clause and
  its `GIN` index were added by hand in
  `src/migrations/…-InitSchema.ts`, matching `db/schema.sql`'s design from
  HW #12 — see that migration file's own header comment.

## Concurrency (HW #14)

`src/checkout.ts` — decrement stock, decrement the buyer's balance, insert
the order, queue a post-processing task, one transaction
(`AppDataSource.transaction(...)`, one connection for the whole thing, not
`pool.query('BEGIN')` on a shared pool). Either everything commits or
nothing does — no orphaned orders, no order that exists without stock
actually having been taken.

### Pessimistic lock vs atomic `UPDATE ... RETURNING`

Went with the atomic `UPDATE products SET stock = stock - $1 WHERE id = $2
AND stock >= $1 RETURNING price_cents` — not `SELECT ... FOR UPDATE` then a
second `UPDATE`. Both are race-free (`FOR UPDATE` blocks a second
transaction on the same row exactly like the atomic `UPDATE`'s row lock
does); the difference is where the decision lives. The atomic form makes
the check *and* the write the same statement — there is no read step in
application code between them for a bug to insert a bad decision into.
`SELECT ... FOR UPDATE` still requires reading a value into JS, deciding,
and issuing a second statement — get that ordering wrong even slightly
(skip re-reading after the lock, cache the value, decide from stale state)
and it's the exact read-modify-write anti-pattern this whole assignment
exists to rule out. One round trip instead of two is a genuine bonus, but
not the reason for the choice.

### `npm run demo:race` — 60 concurrent checkouts, stock=10

```
Attempts: 60
Succeeded: 10
Failed (out of stock): 50
Final stock: 0
Rows with negative stock (any product): 0
Elapsed: 56 ms
✓ No oversell
```

Exactly 10 succeed — no more, no fewer — regardless of the fact that all 60
`checkout()` calls fire at once via a bare `Promise.all` (each call catches
its own rejection so one failure can't short-circuit the batch before the
rest settle). Every rejection is a real, correct `InsufficientStockError`,
not a crash or a corrupted row.

### `npm run demo:workers` — SKIP LOCKED task queue, 4 workers

```
Seeded 40 tasks, 30ms of simulated work each.
Ideal parallel time: 300ms · sequential: 1200ms
Distribution: worker-1=10, worker-2=10, worker-3=10, worker-4=10
Processed twice (or not exactly once): 0
Elapsed: 354ms (sequential estimate: 1200ms)
✓ Every task processed exactly once
```

A perfectly even 10/10/10/10 split and 354 ms against a 1200 ms sequential
baseline (close to the 300 ms parallel ideal) — `FOR UPDATE SKIP LOCKED`
means a worker that finds every unclaimed row already locked moves on to
the next one instead of queueing behind it, so no two workers can ever
claim the same task. A worker seeing zero rows re-checks whether the queue
is *actually* empty before stopping — "nothing free right now" and "queue
drained" are different states, and stopping on the first one would abandon
tasks other workers just haven't gotten to yet.

### `npm run demo:retry` — provoked 40001, 10 concurrent writers

```
Conflicts caught and retried (40001/40P01): 45
Final stock: 10 (expected: 10)
Elapsed: 2760ms
✓ 45 conflict(s) recovered via retry, final state arithmetically correct
```

10 transactions under `REPEATABLE READ` each `SELECT` the same row, sleep
60ms (deliberately widening the read/write window so they collide), then
`UPDATE` from what they read — the read-modify-write-in-JS pattern
`checkout.ts` avoids everywhere else, done here on purpose to provoke
`could not serialize access due to concurrent update` (`40001`). 45
conflicts were caught and retried across the 10 writers (a conflict can
itself collide with another retry — contention cascades, which is why
`withRetry`'s backoff is capped rather than left to grow unbounded); final
stock lands on exactly 10, proving no update was silently lost to a retry
that only re-ran the write instead of the whole transaction.

### Why retry only catches `40001` and `40P01`

`40001` (`serialization_failure`) and `40P01` (`deadlock_detected`) are
Postgres's two explicit "this transaction did nothing — the state is exactly
as if it had never run, and you should try the whole thing again" signals.
That's a very narrow, very safe class to blanket-retry: nothing partial
happened, so replaying the entire transaction (reads included) can't
duplicate an effect or skip one. Any other error — a constraint violation,
`InsufficientStockError`/`InsufficientBalanceError`, a genuine bug, a
connection drop — means something else entirely happened (or the caller's
own business rule correctly rejected the request), and blindly retrying
those would either loop on a request that can never succeed or, worse, risk
side effects an idempotency key isn't protecting here. Retrying "the DB
asked us to" is safe; retrying "something failed" is not.

## Data layer ops (HW #15)

Two production attributes on top of HW #12–14's schema/ORM/concurrency
layer: a connection pooler on the DB side, and a backup whose restore has
actually been tested, once, for real — not just produced and trusted.

### Bringing it up

```bash
npm run db:up        # docker compose up -d --wait + aligns app_user's password
npm start            # app on :3000 — connects through PgBouncer, not directly
```

`docker-compose.yml` now runs three services: `db` (Postgres, unchanged —
still published on `:5433` for direct/admin access), `pgbouncer` (published
on `:6432`, `pool_mode = transaction`), and `restore` (profile `drill` only
— brought up and torn down entirely by `scripts/restore-drill.sh`, never by
hand). `.env`'s `DB_URL` points at `:6432` now, not `:5433` — that one value
change is what makes the app, and every `npm run migrate`/`seed`/`demo:*`
script (all built on the same `src/data-source.ts`), talk to PgBouncer
instead of Postgres directly. No new secret: PgBouncer authenticates
against `pgbouncer/userlist.txt`, holding copies of the exact same dev
credentials `docker-compose.yml`/`init.sql` already define.

### PgBouncer transaction mode: what it breaks

`pool_mode = transaction` is the whole reason a pooler helps here: a client
holds a "connection" to PgBouncer, but the real Postgres backend connection
is handed out only for the lifetime of one transaction, then returned to
the pool — `max_client_conn` clients (200 here) can share
`default_pool_size` real backend connections (8 here). The cost is that
nothing tied to a *session* (as opposed to a transaction) survives between
transactions, because the next one may land on a different backend
entirely:

- **`SET`/`SET LOCAL` issued outside a transaction.** A bare `SET` sent as
  its own statement is gone the instant that implicit transaction ends —
  the next statement may run on a different backend that never saw it.
  (`SET` *inside* an explicit transaction, like `demo-retry.ts`'s
  `BEGIN ISOLATION LEVEL REPEATABLE READ`, is fine: the whole transaction
  is one lease on one backend.)
- **`LISTEN`/`NOTIFY`.** A `LISTEN` registers interest on whatever backend
  happens to be holding the connection at that moment — the next
  transaction can get handed a different backend that was never told to
  listen for anything.
- **Session-level advisory locks** (`pg_advisory_lock`, as opposed to the
  transaction-scoped `pg_advisory_xact_lock`) — same problem: the lock lives
  on a specific backend session, which transaction pooling doesn't
  guarantee to keep reserved for that client.
- **Named/server-side prepared statements.** A driver that prepares a
  statement by name on one backend and later tries to `EXECUTE` it after
  landing on a different one gets "prepared statement does not exist".
  This project's driver (`pg`, via `node-postgres`) doesn't use named
  prepared statements by default, so nothing here actually hits this —
  `max_prepared_statements = 200` in `pgbouncer.ini` is headroom per the
  assignment's own hint (PgBouncer ≥ 1.21 can track and re-prepare them
  itself), not a fix for an observed failure.

`scripts/backup.sh` deliberately does **not** go through PgBouncer for
exactly this reason — see that file's own header comment: `pg_dump` issues
session-level `SET`s before opening its snapshot transaction, and under
transaction pooling those aren't guaranteed to land on the same backend as
the dump itself.

### Backup

```bash
npm run backup
# Backup created: backups/marketplace_20260930_230705.dump (20K)
```

`pg_dump -Fc`, run inside the `db` container (`docker compose exec -T db
pg_dump …`, not via whatever `pg_dump` happens to be on the caller's `PATH`)
— two independent reasons, both in the script's header comment: version
skew (a host `pg_dump` can emit an archive format this project's
`postgres:16` `pg_restore` can't read — hit exactly this locally, fixed by
dumping with the same image `db` runs) and PgBouncer transaction mode (see
above). Output goes to `backups/` (gitignored), named
`<db>_<YYYYMMDD>_<HHMMSS>.dump`, alongside a `.checksum` sidecar —
`count(*) || '|' || sum(price_cents)` on `products`, captured from the same
`db` connection at the moment of the dump, not re-derived later. `backup.cron`
runs the same script nightly through the same `scripts/with-secrets.sh`
wrapper a human would use.

### Restore drill

```bash
npm run restore-drill
```

Takes the newest file in `backups/`, spins up `restore` (profile `drill`) —
a `postgres:16-alpine` container on a **volume that did not exist a moment
ago** — `pg_restore --no-owner --no-acl` into it, then compares the restored
copy's checksum against the `.checksum` sidecar `scripts/backup.sh` wrote
for that exact dump. Deliberately **not** a live re-query of the current
DB: a nightly backup and a morning drill are hours apart, and anything
written to `products` in between (another demo run, a real order) would
read back as a false `MISMATCH` against a dump that was perfectly fine —
the sidecar freezes what *this dump* actually contains. `--no-acl` alongside
the assignment's own `--no-owner` hint for the same reason: the dump also
carries `init.sql`'s `GRANT … TO app_user`, and that role deliberately
doesn't exist in this disposable target. Prints `MATCH` and exits 0, or
`MISMATCH`/a restore error and exits non-zero. Self-cleans via a `trap` on
exit — success or failure — so the container and volume are gone again by
the time the script returns, and a second run is guaranteed to restore into
a genuinely empty database, not leftovers from the first. Cleanup goes
through `docker compose … down -v restore` rather than a hardcoded volume
name, so it still finds and removes the right volume under a different
`COMPOSE_PROJECT_NAME` instead of leaving it behind for the next run to
collide with. Recorded result of one real run:
[RESTORE-DRILL.md](RESTORE-DRILL.md).

### Rotation still works with PgBouncer in front

HW #11's `rotate.sh` (zero-downtime password rotation) gained one more step
because of PgBouncer: PgBouncer authenticates `app_user` against its own
copy of the password in `pgbouncer/userlist.txt`, separate from Postgres's
and from `secrets/db_password`. Without syncing it, the rotation would still
"succeed" in Postgres and in the secret file, but the very next transaction
PgBouncer opens to the real backend — or the very next client connection
using the newly-rotated password — would fail to authenticate. `rotate.sh`
now also rewrites that line and issues `RELOAD` through PgBouncer's admin
console — proven locally: `npm start`, `bash rotate.sh` mid-request,
`curl localhost:3000/health` still `200`, same process, same as before HW
#15 added the pooler in between.

One real, load-bearing fix this required:
`docker-compose.yml`'s `pgbouncer` service originally bind-mounted
`pgbouncer.ini`/`userlist.txt` as two individual files. `rotate.sh` editing
`userlist.txt` via `sed -i` (both GNU and BSD sed rewrite-then-rename rather
than truly edit in place) silently broke that mount — the container kept
pointing at the now-unlinked original inode and stopped seeing the file at
all. Fixed by bind-mounting the whole `pgbouncer/` directory instead, which
follows renames inside it. Caught by actually rotating twice in a row
against a live container, not assumed to work from reading the compose file.

## Testing (HW #16)

A trust ladder on top of HW #9/#13/#14: real-Postgres integration tests
(testcontainers, not mocks), an E2E happy path through the real app
(supertest, no provider substitution), and a Pact contract that makes
HW #9's OpenAPI spec executable — verified against a real Pact Broker, with
`can-i-deploy` as an actual gate, not a rubber stamp.

```bash
npm run test:integration   # 2 repositories × 3+ tests, postgres:16-alpine via testcontainers
npm run test:e2e           # supertest against the real createApp(), DB from a testcontainer
npm run test:contract      # Pact consumer test -> pacts/*.json
npm run verify:provider    # the real app answers every interaction in the contract
```

### Integration suite: testcontainers, not mocks

`test/integration/testkit/container.js` starts a real `postgres:16-alpine`
(`@testcontainers/postgresql`) and builds its schema from the **actual**
migrations this project ships (`src/migrations/*.ts`, HW #13/#14) — not a
hand-rolled copy of the DDL that could quietly drift from what production
actually runs. `UserRepository`/`OrderRepository`
(`src/repositories/*.ts`) are deliberately **not** built on TypeORM's own
`Repository` — they accept a bare `Queryable` (anything with `.query()`:
a `Pool` in production, a single `PoolClient` mid-transaction in tests),
which is the seam the isolation strategy below needs.

Each file covers what a mocked repository structurally cannot:
`user.repository.test.js` proves a duplicate email hits Postgres's real
`UNIQUE` index (`23505`) and that `upsertByEmail()`'s `ON CONFLICT` actually
upserts instead of erroring; `order.repository.test.js` proves a bad
`product_id` hits the real FK (`23503`), that `findWithItems()`'s `JOIN`
resolves to a real product row (not just an id a mock would never check),
and that `totalSpentByUser()`'s aggregate sums real rows.

**Isolation strategy: one testcontainer per file, one transaction per
test.** `beforeEach` opens a `BEGIN` on a dedicated `PoolClient` from the
pool and hands it to the repository under test; `afterEach` issues
`ROLLBACK` and releases the client. Chosen over TRUNCATE (would work, but
resets sequences and needs explicit ordering as tables grow) and a fresh
container per test (correct in isolation, but pays a ~1s container-start
tax per test instead of once per file — the lecture's own measured
comparison, reproduced here, makes that cost concrete). ROLLBACK gives
perfect isolation at the cost of one open transaction per test, which this
suite's size never notices. Verified, not assumed: `npm run test:integration
&& npm run test:integration` — both runs green, no manual cleanup between
them, because nothing a test writes ever survives its own transaction.

One real bug this caught before it ever reached a test assertion: the
testkit's first draft opened a **second**, throwaway `Pool` just to run
migrations and never `.end()`ed it (nothing kept a reference to call that
on). That connection outlived the function, and when a later test's
`container.stop()` killed Postgres, the orphaned connection received
"terminating connection due to administrator command" with no `error`
listener attached — jest reported "Unhandled error" on an otherwise
perfectly green suite. Fixed by using ONE pool for both migrations and the
handle tests get, with a `pool.on('error', ...)` safety net (the same
pattern `app.js`'s own pool already uses for exactly this reason).

### E2E: the real app, no substitution

`test/e2e/app.e2e.test.js` calls `createApp()` straight from `app.js` —
the exact factory `npm start` itself calls — and points its DB config at a
fresh testcontainer instead of `.env`. No Nest here: this project's chosen
stack is Express + `express-openapi-validator` (HW #9's own "variant B"
decision), so "the real app, no provider substitution" means the same
`createApp()` supertest drives, not a parallel DI module built only for
tests. No migrations run against the testcontainer either — `/products` and
`/orders` are in-memory by that same HW #9 decision, not DB-backed; the
testcontainer exists because `app.js` fails fast without a real,
reachable Postgres for its config validation and `/health` route, the same
contract it has everywhere else. Happy path: `POST /products` → `201`,
then `GET /products/:id` → `200` the identical row. Negative case:
an unknown id → `404 application/problem+json`, not a crash.

### Contract: Pact makes the OpenAPI spec executable

`test/contract/consumer.pact.test.js` — an imagined frontend,
`marketplace-web`, describes `GET /products/{productId}` (straight out of
`openapi/openapi.yaml`) against a Pact mock server and writes
`pacts/marketplace-web-marketplace-api.json`. `test/contract/verify-provider.js`
then runs the **real** app and asks `@pact-foundation/pact`'s `Verifier`
to replay every interaction against it — `stateHandlers` is where a
DB-backed resource would get seeded (`INSERT ... ON CONFLICT DO NOTHING`,
so verification stays repeatable); this project's one interaction needs a
no-op handler instead, because `app.js`'s product catalog is in-memory and
`seedProducts()` already guarantees `prod_1` exists the instant the app
finishes starting — there's no SQL this particular precondition needs.

Neither contract file runs under jest: `@pact-foundation/pact`'s `Verifier`
module transitively requires an ESM-only `https-proxy-agent`, which jest's
module loader (with this project's `transform: {}`) refuses to load without
an extra babel transform — plain Node's own `require()` handles it fine (its
built-in ESM/CJS interop is less strict than jest's), so both files run
under Node's native `node:test` / a plain script instead of fighting jest
over a dependency three levels removed from anything this project wrote.

`npm run verify:provider` has two legal forms, chosen by whether
`PACT_BROKER_URL` is set:

- **unset** — verifies against the local `pacts/*.json` file directly, no
  broker involved. This is what a bare `npm run verify:provider` does.
- **set** — verifies against the broker's latest contract for this
  consumer AND publishes the result back (`publishVerificationResult`).

### Broker + the `can-i-deploy` gate, locally

```bash
docker compose up -d --wait        # pact-broker healthy on :9292
```

The **main path** for everything below is the HW #11 vault wrapper, exactly
like every other secret this project has:

```bash
bash scripts/with-secrets.sh dev npm run verify:provider
```

`scripts/with-secrets.sh` resolves `PACT_BROKER_URL`/`PACT_BROKER_TOKEN` the
same way it resolves the DB password — from `secrets/pact_broker_url` /
`secrets/pact_broker_token` if those files exist (gitignored, same
convention as `secrets/db_password`), falling back to this repo's own
local broker (`http://127.0.0.1:9292`, not a secret — it's just this
compose file's own address) and an empty token (correct for this local
broker, which runs with no auth configured) when they don't. Under
`SKIP_VAULT=1` it executes the exact same `npm run verify:provider` the
grader's escape hatch below also runs — same command, different source for
the two env vars.

The **grader's escape hatch** (no access to this repo's vault) sets the
same variable directly:

```bash
PACT_BROKER_URL=http://127.0.0.1:9292 npm run verify:provider   # exit 0, publishVerificationResult: true
```

Both forms are legal; `with-secrets.sh` is just what makes the first one
unprefixed everywhere else in this project too.

**Proof the gate is real — before and after, same command, pasted
verbatim:**

Publish the contract, then ask `can-i-deploy` *before* any provider
version has been verified or tagged:

```bash
curl -s -X PUT "http://127.0.0.1:9292/pacts/provider/marketplace-api/consumer/marketplace-web/version/1.0.0" \
  -H 'Content-Type: application/json' -d @pacts/marketplace-web-marketplace-api.json
# publish -> 201

curl -s "http://127.0.0.1:9292/can-i-deploy?pacticipant=marketplace-web&version=1.0.0&to=prod"
```
```json
{"summary":{"deployable":null,"reason":"There is no verified pact between version 1.0.0 of marketplace-web and the latest version of marketplace-api with tag prod (no such version exists)","success":0,"failed":0,"unknown":1}, ...}
```

`deployable: null`, `unknown: 1` — there is no provider version tagged
`prod` yet, so the broker's only honest answer is "I don't know". Now
verify (publishing the result) and tag that same provider version `prod`:

```bash
PACT_BROKER_URL=http://127.0.0.1:9292 PROVIDER_VERSION=1.0.0 npm run verify:provider
# ... has a matching body (OK) ... "result":true

curl -s -X PUT "http://127.0.0.1:9292/pacticipants/marketplace-api/versions/1.0.0/tags/prod" \
  -H 'Content-Type: application/json'
# tag -> 201
```

Ask the exact same question again:

```bash
curl -s "http://127.0.0.1:9292/can-i-deploy?pacticipant=marketplace-web&version=1.0.0&to=prod"
```
```json
{"summary":{"deployable":true,"reason":"All required verification results are published and successful","success":1,"failed":0,"unknown":0}, ...}
```

`deployable: true`. Nothing else changed between the two calls except that
the provider version `can-i-deploy` was asking about went from untagged to
tagged `prod` with a published, successful verification sitting behind it
— which is the entire mechanism `can-i-deploy` exists to check, not a
gate that's wired to always say yes.

### CI: the same gate, automated

`.github/workflows/contract.yml`'s `contract` job runs the identical
sequence against the commit's own SHA as the provider/consumer version:
bring up the stack → `test:contract` → publish → `verify:provider` with
`PACT_BROKER_URL` pointed at the job's own broker container
(`publishVerificationResult: true`) → tag that SHA `prod` → `can-i-deploy`,
and fails the job outright if `deployable` isn't `true`. `PACT_BROKER_TOKEN`
would come from a GitHub Actions secret in a real hosted-broker setup; this
job's local broker needs none, same as the walkthrough above.

## Verification (acceptance criteria)

Spec is valid:

```bash
npx @redocly/cli lint openapi/openapi.yaml
# exit 0, only warnings allowed (info-license, no-server-example.com)
```

Spec size:

```bash
npx @redocly/cli bundle openapi/openapi.yaml -o spec.json
node -e "const s=require('./spec.json'),M=['get','post','put','patch','delete'];\
const ops=Object.entries(s.paths).flatMap(([p,v])=>Object.keys(v).filter(m=>M.includes(m)).map(m=>[p,m]));\
const idem=ops.flatMap(([p,m])=>s.paths[p][m].parameters??[]).find(x=>x.in==='header'&&/idempotency-key/i.test(x.name));\
console.log('operations:',ops.length,'· resources:',new Set(Object.keys(s.paths).map(p=>p.split('/')[1])).size);\
console.log('Idempotency-Key: required =',idem?.required,'· description length =',(idem?.description??'').trim().length)"
# expected: operations: 6 · resources: 2 · required = true · description length = 393
```

`Idempotency-Key`, `next_cursor`, `problem+json` are declared:

```bash
grep -c 'Idempotency-Key' openapi/openapi.yaml           # ≥ 1
grep -c 'next_cursor' openapi/openapi.yaml               # ≥ 1
grep -c 'application/problem+json' openapi/openapi.yaml  # ≥ 2
```

The server really does reject anything that violates the spec (after
`npm start`, in another terminal):

```bash
# no Idempotency-Key -> 400 problem+json
curl -si -X POST localhost:3000/orders \
  -H 'Content-Type: application/json' \
  -d '{"items":[{"product_id":"prod_1","quantity":1}]}'
# HTTP/1.1 400 Bad Request, Content-Type: application/problem+json
# detail: "request/headers must have required property 'idempotency-key'"

# empty items -> 400 problem+json
curl -si -X POST localhost:3000/orders \
  -H 'Content-Type: application/json' -H 'Idempotency-Key: k1' \
  -d '{"items":[]}'
# detail: "request/body/items must NOT have fewer than 1 items"

# valid request -> 201
curl -si -X POST localhost:3000/orders \
  -H 'Content-Type: application/json' -H 'Idempotency-Key: k2' \
  -d '{"items":[{"product_id":"prod_1","quantity":2}]}'
```

### Bonus challenge (no extra points) — implemented

Full `Idempotency-Key` semantics:

```bash
# same key + same body again -> same 201, Idempotency-Replay: true
curl -si -X POST localhost:3000/orders \
  -H 'Content-Type: application/json' -H 'Idempotency-Key: k2' \
  -d '{"items":[{"product_id":"prod_1","quantity":2}]}' | grep -i "^HTTP\|idempotency-replay"

# same key, different body -> 422 problem+json
curl -si -X POST localhost:3000/orders \
  -H 'Content-Type: application/json' -H 'Idempotency-Key: k2' \
  -d '{"items":[{"product_id":"prod_2","quantity":1}]}'
```

Cursor pagination:

```bash
curl -s "localhost:3000/products?limit=2"
# {"items":[...two products...],"next_cursor":"<opaque token>"}
curl -s "localhost:3000/products?limit=2&cursor=<that token from the previous response>"
# last product, "next_cursor": null
```

## Notes worth knowing

- **Header names in code are always lowercase.** Express (and
  `express-openapi-validator` itself) puts headers into `req.headers` in
  lowercase regardless of how the spec (`Idempotency-Key`) or the client
  wrote them. That's why both the error `detail` and `app.js` consistently
  use `'idempotency-key'` lowercase.
- **`price_cents`/`total_cents` are `integer`, not a decimal string.**
  Money is counted in cents on purpose — a `"2600.00"` string was the pain
  point of v1 from the lecture; this doesn't repeat it.
- **`validateResponses: true` is the enforcement, not the spec by itself.**
  If a handler returned `totalCents` instead of `total_cents`, the
  validator would itself return 500 with
  `detail: "/response must have required property 'total_cents'"` — the
  spec here isn't just documentation, it physically rejects a wrong
  response before it reaches the client.
- **`bundle` without `--dereferenced` doesn't resolve internal `$ref`s.**
  That's why `Idempotency-Key` is described inline right in the
  `POST /orders` operation instead of via `components.parameters` — the
  acceptance-criteria script from the assignment reads `parameters`
  without dereferencing.

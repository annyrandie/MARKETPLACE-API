# Marketplace API

Course project HW #9: a contract (`openapi/openapi.yaml`) plus a working
boundary that actually enforces it. HW #11 adds the configuration skeleton
underneath it: `process.env` → zod schema (fail-fast) → typed config → code,
and a DB password that lives in a file and rotates without a restart. See
[Configuration](#configuration) below. HW #12 adds the data layer under
*that*: schema, seed, four slow queries proven slow and then proven fixed
under real volume, and full-text search. See [Data layer](#data-layer-hw-12)
below.

## Quickstart for the grader

Works on a bare `git clone` — no `.env`, no file edits.

Bring up the database:

    docker compose up -d --wait

Connect:

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

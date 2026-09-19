# Optimizations — HW #12

Numbers below are from one real run against the seed in `db/seed.sql`
(120 000 products, 150 000 orders, 10 000 users, 300 000 order_items;
PostgreSQL 16-alpine, Docker Desktop on Apple Silicon). `random()` reseeds
differently on every `seed.sql` run, so exact row counts and timings will
differ on another machine — the plan **shape** (Seq Scan → indexed scan) and
the order of magnitude of the speedup won't.

Pipeline exactly as specified: clean volume → `schema.sql` → `seed.sql` →
EXPLAIN "before" → `indexes.sql` → `ANALYZE` → EXPLAIN "after".

## q1 — orders by owner + period

`db/queries/q1.sql` — a user's own orders from the last year, most recent
first, paginated (the same shape as a real "my orders" API endpoint).

### Before (`idx_orders_user_created` does not exist yet)

```
                                                          QUERY PLAN
-------------------------------------------------------------------------------------------------------------------------------
 Limit  (cost=4154.76..4155.22 rows=4 width=31) (actual time=4.303..5.524 rows=5 loops=1)
   Buffers: shared hit=1427
   ->  Gather Merge  (cost=4154.76..4155.22 rows=4 width=31) (actual time=4.302..5.522 rows=5 loops=1)
         Workers Planned: 1
         Workers Launched: 1
         Buffers: shared hit=1427
         ->  Sort  (cost=3154.75..3154.76 rows=4 width=31) (actual time=3.511..3.511 rows=2 loops=2)
               Sort Key: created_at DESC
               Sort Method: quicksort  Memory: 25kB
               Buffers: shared hit=1427
               Worker 0:  Sort Method: quicksort  Memory: 25kB
               ->  Parallel Seq Scan on orders  (cost=0.00..3154.71 rows=4 width=31) (actual time=1.541..3.465 rows=2 loops=2)
                     Filter: ((user_id = 4242) AND (created_at >= (now() - '365 days'::interval)))
                     Rows Removed by Filter: 74998
                     Buffers: shared hit=1390
 Planning:
   Buffers: shared hit=97
 Planning Time: 0.251 ms
 Execution Time: 5.558 ms
```

### After (`CREATE INDEX idx_orders_user_created ON orders (user_id, created_at)`)

```
                                                                 QUERY PLAN
--------------------------------------------------------------------------------------------------------------------------------------------
 Limit  (cost=31.24..31.26 rows=7 width=31) (actual time=0.071..0.072 rows=5 loops=1)
   Buffers: shared hit=11 read=3
   ->  Sort  (cost=31.24..31.26 rows=7 width=31) (actual time=0.070..0.071 rows=5 loops=1)
         Sort Key: created_at DESC
         Sort Method: quicksort  Memory: 25kB
         Buffers: shared hit=11 read=3
         ->  Bitmap Heap Scan on orders  (cost=4.50..31.15 rows=7 width=31) (actual time=0.039..0.057 rows=5 loops=1)
               Recheck Cond: ((user_id = 4242) AND (created_at >= (now() - '365 days'::interval)))
               Heap Blocks: exact=5
               Buffers: shared hit=8 read=3
               ->  Bitmap Index Scan on idx_orders_user_created  (cost=0.00..4.50 rows=7 width=0) (actual time=0.031..0.031 rows=5 loops=1)
                     Index Cond: ((user_id = 4242) AND (created_at >= (now() - '365 days'::interval)))
                     Buffers: shared hit=3 read=3
 Planning:
   Buffers: shared hit=134 read=2
 Planning Time: 0.519 ms
 Execution Time: 0.106 ms
```

**What changed:** `Bitmap Index Scan on idx_orders_user_created` replaces
`Parallel Seq Scan on orders` — the composite index (equality column
`user_id` first, range column `created_at` second, matching the
lecture's rule) lets the planner jump straight to this user's rows within
the date range instead of reading and discarding ~75 000. Buffers
1427 → 11 (~130×), 5.56 ms → 0.11 ms (~52×).

## q2 — orders by status

`db/queries/q2.sql` — the newest `pending` orders (an admin queue view).
`pending` is a deliberately skewed ~6% of `orders` (90/6/4 completed/
pending/cancelled), the same shape as the lecture's demo.

### Before

```
                                                      QUERY PLAN
----------------------------------------------------------------------------------------------------------------------
 Limit  (cost=3571.78..3571.91 rows=50 width=30) (actual time=6.601..6.606 rows=50 loops=1)
   Buffers: shared hit=1393
   ->  Sort  (cost=3571.78..3594.87 rows=9235 width=30) (actual time=6.600..6.603 rows=50 loops=1)
         Sort Key: created_at DESC
         Sort Method: top-N heapsort  Memory: 30kB
         Buffers: shared hit=1393
         ->  Seq Scan on orders  (cost=0.00..3265.00 rows=9235 width=30) (actual time=0.005..5.861 rows=9034 loops=1)
               Filter: (status = 'pending'::text)
               Rows Removed by Filter: 140966
               Buffers: shared hit=1390
 Planning:
   Buffers: shared hit=92
 Planning Time: 0.340 ms
 Execution Time: 6.652 ms
```

### After (`CREATE INDEX idx_orders_pending ON orders (created_at) WHERE status = 'pending'`)

```
                                                                    QUERY PLAN
--------------------------------------------------------------------------------------------------------------------------------------------------
 Limit  (cost=0.29..32.74 rows=50 width=30) (actual time=0.024..0.132 rows=50 loops=1)
   Buffers: shared hit=50 read=2
   ->  Index Scan Backward using idx_orders_pending on orders  (cost=0.29..5802.37 rows=8940 width=30) (actual time=0.023..0.128 rows=50 loops=1)
         Buffers: shared hit=50 read=2
 Planning:
   Buffers: shared hit=125
 Planning Time: 0.325 ms
 Execution Time: 0.151 ms
```

**What changed:** `Index Scan Backward using idx_orders_pending` replaces
`Seq Scan on orders` + a `top-N heapsort` — the partial index already
contains only `pending` rows pre-sorted by `created_at`, so the planner
walks it backward and stops at 50 rows instead of scanning + sorting all
~9 000 pending rows out of 150 000. The `Sort` node is gone entirely.
Buffers 1393 → 52 (~27×), 6.65 ms → 0.15 ms (~44×).

## q3 — case-insensitive lookup

`db/queries/q3.sql` — find a user by email, case-insensitively (login-style
lookup; emails are seeded in mixed case on purpose, e.g. `User4242@Example.COM`).

### Before

```
                                            QUERY PLAN
---------------------------------------------------------------------------------------------------
 Seq Scan on users  (cost=0.00..254.00 rows=50 width=45) (actual time=0.659..1.576 rows=1 loops=1)
   Filter: (lower(email) = 'user4242@example.com'::text)
   Rows Removed by Filter: 9999
   Buffers: shared hit=104
 Planning:
   Buffers: shared hit=84
 Planning Time: 0.219 ms
 Execution Time: 1.589 ms
```

### After (`CREATE INDEX idx_users_email_lower ON users (lower(email))`)

```
                                                          QUERY PLAN
------------------------------------------------------------------------------------------------------------------------------
 Index Scan using idx_users_email_lower on users  (cost=0.29..8.30 rows=1 width=45) (actual time=0.017..0.018 rows=1 loops=1)
   Index Cond: (lower(email) = 'user4242@example.com'::text)
   Buffers: shared hit=1 read=2
 Planning:
   Buffers: shared hit=103 read=1
 Planning Time: 0.298 ms
 Execution Time: 0.034 ms
```

**What changed:** `Index Scan using idx_users_email_lower` replaces
`Seq Scan on users`, and the condition moved from `Filter` to `Index Cond`
— a plain index on `email` stores the raw mixed-case values, so it could
never match a `lower(email) = …` filter; the expression had to be baked
into the index itself. Buffers 104 → 3 (~35×), 1.59 ms → 0.03 ms (~47×).

## q4 — full-text search over the catalog

`db/queries/q4.sql` — the exact query from the assignment: up to 20 products
ranked by relevance for `'шкіряні кросівки'`. 720 of 120 000 products match
both words (0.6% of the catalog) — comfortably inside "units of a percent",
so the planner has a real reason to prefer the index over a Seq Scan.

Run 3 times after `CREATE INDEX`, as instructed — the first hit a cold GIN
and was ~1.5–2× slower than runs 2–3; the number below is the last of three.

### Before (`idx_products_search_vector` does not exist yet)

```
                                                      QUERY PLAN
----------------------------------------------------------------------------------------------------------------------
 Limit  (cost=7961.27..7961.31 rows=13 width=44) (actual time=11.997..11.998 rows=20 loops=1)
   Buffers: shared hit=6467
   ->  Sort  (cost=7961.27..7961.31 rows=13 width=44) (actual time=11.995..11.996 rows=20 loops=1)
         Sort Key: (ts_rank(search_vector, '''шкіряні'' & ''кросівки'''::tsquery)) DESC, id
         Sort Method: top-N heapsort  Memory: 27kB
         Buffers: shared hit=6467
         ->  Seq Scan on products  (cost=0.00..7961.03 rows=13 width=44) (actual time=0.011..11.913 rows=720 loops=1)
               Filter: (search_vector @@ '''шкіряні'' & ''кросівки'''::tsquery)
               Rows Removed by Filter: 119280
               Buffers: shared hit=6461
 Planning:
   Buffers: shared hit=126
 Planning Time: 0.310 ms
 Execution Time: 12.019 ms
```

### After (`CREATE INDEX idx_products_search_vector ON products USING GIN (search_vector)`, 3rd run)

```
                                                                    QUERY PLAN
---------------------------------------------------------------------------------------------------------------------------------------------------
 Limit  (cost=83.76..83.80 rows=15 width=44) (actual time=2.299..2.301 rows=20 loops=1)
   Buffers: shared hit=687
   ->  Sort  (cost=83.76..83.80 rows=15 width=44) (actual time=2.298..2.299 rows=20 loops=1)
         Sort Key: (ts_rank(search_vector, '''шкіряні'' & ''кросівки'''::tsquery)) DESC, id
         Sort Method: top-N heapsort  Memory: 27kB
         Buffers: shared hit=687
         ->  Bitmap Heap Scan on products  (cost=25.41..83.47 rows=15 width=44) (actual time=0.274..2.130 rows=720 loops=1)
               Recheck Cond: (search_vector @@ '''шкіряні'' & ''кросівки'''::tsquery)
               Heap Blocks: exact=675
               Buffers: shared hit=681
               ->  Bitmap Index Scan on idx_products_search_vector  (cost=0.00..25.41 rows=15 width=0) (actual time=0.209..0.210 rows=720 loops=1)
                     Index Cond: (search_vector @@ '''шкіряні'' & ''кросівки'''::tsquery)
                     Buffers: shared hit=6
 Planning:
   Buffers: shared hit=151
 Planning Time: 0.860 ms
 Execution Time: 2.379 ms
```

**What changed:** `Bitmap Index Scan on idx_products_search_vector`
replaces `Seq Scan on products` — GIN holds an inverted list per lexeme, so
it finds exactly the 720 matching rows directly instead of tokenizing and
filtering all 120 000. Buffers 6467 → 687 (~9.4×), 12.0 ms → 2.4 ms (~5×).
Worth naming honestly: q4's *buffer* win (~9.4×) is much bigger than its
*time* win (~5×) — unlike q1–q3, which each return a handful of rows, this
query still has to fetch 720 real heap rows (`Heap Blocks: exact=675`) to
compute `ts_rank` on each; the index removes the scan of the other 119 280,
but not the cost of visiting the rows that actually match.

## Морфологія

`simple`, the text search config used for `search_vector`, does **not**
stem — it only lowercases and tokenizes. Counted on this base:

```sql
SELECT count(*) FROM products WHERE search_vector @@ plainto_tsquery('simple', 'кросівки'); -- 2370
SELECT count(*) FROM products WHERE search_vector @@ plainto_tsquery('simple', 'кросівок'); --    0
```

**2370** matches for the nominative plural **кросівки**, **0** for the
genitive plural **кросівок** — same product, same shopper intent, different
grammatical case, and `simple` treats them as two unrelated tokens because
it has no Ukrainian (or even Russian) stemming dictionary to reduce either
form to a common lexeme: `SELECT count(*) FROM pg_ts_config;` lists 29
built-in configs and `\dF` names them — English, German, Russian, Romanian,
even Armenian and Nepali, but no `ukrainian`, and switching to `russian`
would not fix this either (it's a different language with different
inflection, not a drop-in stand-in — that substitution is what the
assignment calls "самообман", not a fix). A real Ukrainian-aware search
needs either a third-party dictionary/stemmer (e.g. an ispell-style
affix file for `uk`) plugged into a custom `CREATE TEXT SEARCH
CONFIGURATION`, or a search engine built for morphology (Lecture #15) —
Postgres's built-in FTS closes the exact-token half of the problem, not
the inflection half.

## Cost of the generated `search_vector` column

Not free, and the assignment asks to be able to say the price out loud, so:
measured on an identical copy of `products` (same 120 000 rows) — one
without the column, one with it added via `ALTER TABLE ... ADD COLUMN
search_vector tsvector GENERATED ALWAYS AS (...) STORED`, both freshly
`VACUUM (ANALYZE)`d:

| | `pg_total_relation_size` |
|---|---|
| `products`-shape table, no `search_vector` | 24 MB |
| same table, after adding `search_vector` | 51 MB |

≈2.1× — matches the assignment's own estimate ("приблизно вдвічі"). The
real `products` table in this schema (column + its GIN index together) is
56 MB total. `INSERT`/`UPDATE` on `name`/`description` also got slower:
every write now recomputes `to_tsvector()` and maintains the GIN index
entry, not just writes the row.

## Index inventory (all four; none dead)

| Index | For | Size | Kind |
|---|---|---|---|
| `idx_orders_user_created` | q1 | 4.6 MB | composite B-tree |
| `idx_orders_pending` | q2 | 216 kB | **partial** B-tree |
| `idx_users_email_lower` | q3 | 416 kB | **expression** B-tree |
| `idx_products_search_vector` | q4 | 3.2 MB | GIN over `tsvector` |

`SELECT indexrelname, idx_scan FROM pg_stat_user_indexes WHERE
schemaname='public' AND indexrelid NOT IN (SELECT conindid FROM
pg_constraint WHERE conindid <> 0);` after all four EXPLAINs above shows
`idx_scan` ≥ 1 for every one of these four — none is dead weight.

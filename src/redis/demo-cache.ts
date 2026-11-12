// npm run demo:cache — cache-aside with jittered TTL + single-flight lock,
// on HW #23's heavy read (product card with sales aggregates).
//
// 1. reads CONFIG from the cache connection itself (is this the LRU box?);
// 2. warms WARM_KEYS cards and counts distinct TTLs (jitter or not);
// 3. deletes one warm key ("just expired") and fires CONCURRENT requests at
//    it through PODS separate Redis connections — db-calls must be 1;
// 4. 100 more reads of the warm cache — db-calls-warm must be 0.
// db-calls is counted per statement sent to Postgres (CountingQueryable),
// not per function call. Self-cleaning: own fixture products, own keys.
import { createDbPool } from '../events/db';
import { finish } from '../outbox/demo-kit';
import { createCacheRedis, readMemoryConfig } from './connections';
import { CacheAside, DEFAULT_CACHE_OPTIONS } from './cache';
import { CountingQueryable, ProductCardRepository, productCardKey } from '../repositories/product-card.repository';

const WARM_KEYS = 60;
const CONCURRENT = 25;
const PODS = 5;
const WARM_READS = 100;
const MARKER = 'redis demo fixture: cache';
// control run: `node dist/redis/demo-cache.js --no-lock` — same stampede,
// no single-flight; db-calls jumps to CONCURRENT and the invariant fails.
const NO_LOCK = process.argv.includes('--no-lock');

async function main(): Promise<void> {
  const pool = createDbPool();
  const pods = Array.from({ length: PODS }, () => createCacheRedis());
  const admin = pods[0];

  const mem = await readMemoryConfig(admin);
  const cacheLru = mem.policy !== null && mem.policy !== 'noeviction' ? 1 : 0;
  const cacheMaxmemory = mem.maxmemory !== null && mem.maxmemory > 0 ? 1 : 0;
  console.error(`cache box: maxmemory-policy=${mem.policy} maxmemory=${mem.maxmemory}`);

  // fixtures: previous run's leftovers first, then a fresh set
  const stale = await pool.query<{ id: string }>(`SELECT id::text AS id FROM products WHERE description = $1`, [MARKER]);
  if (stale.rows.length) await admin.del(...stale.rows.map((r) => productCardKey(r.id)));
  await pool.query(`DELETE FROM products WHERE description = $1`, [MARKER]);
  const { rows: products } = await pool.query<{ id: string }>(
    `INSERT INTO products (name, description, price_cents, stock)
     SELECT 'Cache demo product #' || g, $1, 1000 + g, 100 FROM generate_series(1, $2) g
     RETURNING id::text AS id`,
    [MARKER, WARM_KEYS],
  );
  const ids = products.map((p) => p.id);

  const db = new CountingQueryable(pool);
  const repo = new ProductCardRepository(db);
  const caches = pods.map((r) => new CacheAside(r, { ...DEFAULT_CACHE_OPTIONS, singleFlight: !NO_LOCK }));
  const getCard = (podIdx: number, id: string) => caches[podIdx % PODS].get(productCardKey(id), () => repo.findCard(id));

  let summary: Record<string, number>;
  try {
    // 2. warm-up — one loop, the exact situation that synchronises expiry
    for (const id of ids) await getCard(0, id);
    const ttls = await Promise.all(ids.map((id) => admin.ttl(productCardKey(id))));
    const live = ttls.filter((t) => t > 0);
    console.error(`TTL range: ${Math.min(...live)}..${Math.max(...live)}s`);

    // 3. stampede on a key that just vanished
    const target = ids[0];
    await admin.del(productCardKey(target));
    db.count = 0;
    const results = await Promise.all(Array.from({ length: CONCURRENT }, (_, i) => getCard(i, target)));
    const dbCalls = db.count;
    const consistent = results.every((r) => JSON.stringify(r) === JSON.stringify(results[0])) ? 1 : 0;

    // 4. warm cache — must not touch the DB at all
    db.count = 0;
    for (let i = 0; i < WARM_READS; i++) await getCard(i, ids[i % ids.length]);

    summary = {
      'cache-lru': cacheLru,
      'cache-maxmemory': cacheMaxmemory,
      warmed: live.length,
      'ttl-distinct': new Set(live).size,
      concurrent: CONCURRENT,
      pods: PODS,
      'db-calls': dbCalls,
      'db-calls-warm': db.count,
      'results-consistent': consistent,
    };
  } finally {
    await admin.del(...ids.map(productCardKey), ...ids.map((id) => `lock:${productCardKey(id)}`)).catch(() => {});
    await pool.query(`DELETE FROM products WHERE description = $1`, [MARKER]).catch(() => {});
    await Promise.all(pods.map((r) => r.quit()));
    await pool.end();
  }

  finish(summary, {
    'cache box is LRU with a memory cap': summary['cache-lru'] === 1 && summary['cache-maxmemory'] === 1,
    'warmed >= 50 with jittered TTLs': summary.warmed >= 50 && summary['ttl-distinct'] >= 5,
    'stampede -> exactly one DB call': summary['db-calls'] === 1 && summary['results-consistent'] === 1,
    'warm reads -> zero DB calls': summary['db-calls-warm'] === 0,
  });
}

main().catch((err) => {
  console.error('demo:cache failed:', err);
  process.exit(1);
});

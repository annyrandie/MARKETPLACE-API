// Deliberately provokes 40001 (serialization_failure): several concurrent
// transactions under REPEATABLE READ each SELECT a shared row, sleep (so
// their read/write windows overlap on purpose), then UPDATE it from what
// they read — the exact read-modify-write-in-JS anti-pattern checkout.ts
// avoids everywhere else. Here it's the point: prove the conflict, prove
// the retry wrapper recovers from it without losing an update.
import 'reflect-metadata';
import AppDataSource from './data-source';
import { Product } from './entities/product.entity';
import { withRetry, sleep } from './lib/concurrency';

const CONCURRENT_WRITERS = 10;
const OVERLAP_MS = 60; // read → sleep → write; wide enough that concurrent runs collide reliably

async function racyIncrement(productId: string, label: string, onConflict: () => void): Promise<void> {
  await withRetry(
    label,
    () =>
      AppDataSource.transaction('REPEATABLE READ', async (manager) => {
        const rows: Array<{ stock: number }> = await manager.query('SELECT stock FROM products WHERE id = $1', [productId]);
        const current = rows[0].stock;
        await sleep(OVERLAP_MS); // widen the window — same "think time" as the lecture's transfer demo
        await manager.query('UPDATE products SET stock = $1 WHERE id = $2', [current + 1, productId]);
      }),
    // 10 writers contending for the SAME row under REPEATABLE READ produces
    // a real conflict cascade (a retry can itself collide with another
    // retry) — the default maxAttempts undersells how many rounds it can
    // legitimately take for every one of them to eventually land, not a
    // sign anything is wrong.
    { maxAttempts: 12, onRetry: () => onConflict() },
  );
}

async function main(): Promise<void> {
  await AppDataSource.initialize();

  const productRepo = AppDataSource.getRepository(Product);
  const product = await productRepo.save(
    productRepo.create({
      name: `Retry-demo товар #${Date.now()}`,
      description: 'Одноразовий товар для demo:retry — не з сіда.',
      priceCents: 500,
      stock: 0,
    }),
  );

  console.log(`Firing ${CONCURRENT_WRITERS} concurrent read-modify-write increments at product ${product.id} (stock=0), REPEATABLE READ...`);

  let conflictsCaught = 0;
  const start = Date.now();
  await Promise.all(
    Array.from({ length: CONCURRENT_WRITERS }, (_, i) =>
      racyIncrement(product.id, `writer-${i + 1}`, () => {
        conflictsCaught += 1;
      }),
    ),
  );
  const elapsedMs = Date.now() - start;

  const finalProduct = await productRepo.findOneByOrFail({ id: product.id });

  console.log(`Conflicts caught and retried (40001/40P01): ${conflictsCaught}`);
  console.log(`Final stock: ${finalProduct.stock} (expected: ${CONCURRENT_WRITERS})`);
  console.log(`Elapsed: ${elapsedMs}ms`);

  const arithmeticallyCorrect = finalProduct.stock === CONCURRENT_WRITERS;

  await AppDataSource.destroy();

  if (!arithmeticallyCorrect) {
    console.error('✗ Final state does not match — a retry must have re-run only the write, not the read (lost update).');
    process.exit(1);
  }
  if (conflictsCaught === 0) {
    console.error('✗ No conflict was ever provoked — this run proves nothing. Re-run, or widen OVERLAP_MS.');
    process.exit(1);
  }
  console.log(`✓ ${conflictsCaught} conflict(s) recovered via retry, final state arithmetically correct.`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

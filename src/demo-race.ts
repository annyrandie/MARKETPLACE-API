// 60 concurrent checkout() calls on ONE product with stock=10, one unit
// each. Buyers' balances are deliberately huge — stock has to be the only
// thing that can reject a call, or the number of successes would depend on
// balance math instead of proving anything about the stock race.
//
// Uses its own throwaway product + buyers (created here, not from seed.ts)
// so this demo never depends on — or corrupts — the deterministic seed data.
import 'reflect-metadata';
import AppDataSource from './data-source';
import { Product } from './entities/product.entity';
import { User } from './entities/user.entity';
import { checkout } from './checkout';

const ATTEMPTS = 60; // ≥ 50, required by the assignment
const INITIAL_STOCK = 10;
const HUGE_BALANCE_CENTS = 100_000_000; // never the limiting factor

async function main(): Promise<void> {
  await AppDataSource.initialize();

  const productRepo = AppDataSource.getRepository(Product);
  const userRepo = AppDataSource.getRepository(User);

  const runId = Date.now();
  const product = await productRepo.save(
    productRepo.create({
      name: `Race-demo товар #${runId}`,
      description: 'Одноразовий товар для demo:race — не з сіда.',
      priceCents: 10_000,
      stock: INITIAL_STOCK,
    }),
  );

  const buyers: User[] = [];
  for (let i = 0; i < ATTEMPTS; i++) {
    buyers.push(
      await userRepo.save(
        userRepo.create({
          email: `race-buyer-${runId}-${i}@example.test`,
          fullName: `Race Buyer ${i}`,
          balanceCents: HUGE_BALANCE_CENTS,
        }),
      ),
    );
  }

  console.log(`Firing ${ATTEMPTS} concurrent checkout() calls at product ${product.id} (stock=${INITIAL_STOCK})...`);
  const start = Date.now();

  // Literally Promise.all — every call fires at once, nothing queued in the
  // app. Each mapped promise catches its OWN rejection and resolves to a
  // result object instead, so one buyer losing the stock race doesn't
  // short-circuit Promise.all before the rest have even settled.
  const results = await Promise.all(
    buyers.map(async (buyer) => {
      try {
        await checkout(AppDataSource, buyer.id, product.id, 1);
        return { ok: true } as const;
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) } as const;
      }
    }),
  );
  const elapsedMs = Date.now() - start;

  const succeeded = results.filter((r) => r.ok).length;
  const failed = results.length - succeeded;

  const finalProduct = await productRepo.findOneByOrFail({ id: product.id });
  const negativeStockCount = await productRepo.createQueryBuilder('p').where('p.stock < 0').getCount();

  console.log(`Attempts: ${results.length}`);
  console.log(`Succeeded: ${succeeded}`);
  console.log(`Failed (out of stock): ${failed}`);
  console.log(`Final stock: ${finalProduct.stock}`);
  console.log(`Rows with negative stock (any product): ${negativeStockCount}`);
  console.log(`Elapsed: ${elapsedMs} ms`);

  const oversell = succeeded !== INITIAL_STOCK || finalProduct.stock !== 0 || negativeStockCount > 0;

  await AppDataSource.destroy();

  if (oversell) {
    console.error('✗ OVERSELL DETECTED — invariant violated (succeeded should equal initial stock, final stock should be 0, no negative rows).');
    process.exit(1);
  }
  console.log('✓ No oversell: succeeded === initial stock, final stock === 0, no negative-stock rows anywhere.');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

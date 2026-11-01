// npm run demo:crash-write — side (a): the BUSINESS write fails.
// checkout() inserts the order AND its outbox row, then the transaction
// blows up right after the outbox INSERT (afterOutboxInsert throws). The
// outbox row was really there — the demo reads it back from INSIDE that
// transaction first — and still nothing leaves: one ROLLBACK takes the
// order and the event together, so the relay has nothing to publish and
// the consumer nothing to receive. That's the proof both rows sit under
// one COMMIT, not two.
import { checkout } from '../checkout';
import { drainOutbox } from './relay';
import { openDemo, waitFor, finish, PRODUCT_STOCK } from './demo-kit';

async function main(): Promise<void> {
  const demo = await openDemo('demo-crash-write');

  let writeFailed = 0;
  let outboxInsideTx = 0;
  try {
    await checkout(demo.ds, demo.userId, demo.productId, 1, {
      idempotencyKey: `${demo.keyPrefix}${Date.now()}`,
      afterOutboxInsert: async (manager) => {
        const [row] = await manager.query(
          `SELECT count(*)::int AS n FROM outbox WHERE payload->'data'->>'userId' = $1`,
          [demo.userId],
        );
        outboxInsideTx = row.n;
        throw new Error('simulated crash: business transaction fails after the outbox insert');
      },
    });
  } catch (err) {
    writeFailed += 1;
    console.error(`WRITE FAILED: ${err instanceof Error ? err.message : err}`);
  }

  // Run the relay anyway — if the outbox row had survived the rollback,
  // this is where it would leak out.
  await drainOutbox(demo.pool, demo.publishChannel);
  // Nothing should arrive; wait long enough that "nothing" means something.
  await waitFor(() => demo.seen.deliveries > 0, 1500);

  const c = await demo.counts();
  await demo.close();

  finish(
    {
      'write-failed': writeFailed,
      'outbox-inside-tx': outboxInsideTx,
      orders: c.orders,
      outbox: c.outbox,
      published: c.published,
      deliveries: demo.seen.deliveries,
      effect: c.effect,
      'stock-left': c.stock,
    },
    {
      'write-failed=1': writeFailed === 1,
      'outbox row existed inside the tx': outboxInsideTx === 1,
      'orders=0': c.orders === 0,
      'outbox=0': c.outbox === 0,
      'published=0': c.published === 0,
      'deliveries=0': demo.seen.deliveries === 0,
      'effect=0': c.effect === 0,
      'stock untouched': c.stock === PRODUCT_STOCK,
    },
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

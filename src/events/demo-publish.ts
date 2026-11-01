// npm run demo:publish — happy path: 5 events published with confirms, 5
// deliveries, 5 idempotent effects applied, 0 in the DLQ, and prefetch
// printed as whatever this process actually passed to channel.prefetch().
import 'dotenv/config';
import { createDbPool } from './db';
import { connectBroker } from './connection';
import { assertTopology, QUEUE, DLQ } from './topology';
import { publishOrderPlaced } from './publisher';
import { ensureSchema, resetDemoState, countEffect, countDeliveries } from './effect';
import { runConsumer } from './consumer';

const PREFIX = 'demo-publish:';
const COUNT = 5;
// prefetch × time-per-message must stay well under RabbitMQ's stock
// 30-minute consumer_timeout — see README's "Async events" section for
// the arithmetic. 10 fits comfortably for messages that take single-digit
// milliseconds to process, without starving a second consumer the way an
// unset (0 = unlimited) or an unjustified 500 would.
const PREFETCH = Number(process.env.PREFETCH ?? 10);

async function main(): Promise<void> {
  const pool = createDbPool();
  await ensureSchema(pool);
  await resetDemoState(pool, PREFIX);

  const connection = await connectBroker();
  connection.on('error', (err) => console.error('[broker connection]', err.message));

  // Topology is declared on the CONSUMER's channel, never the publisher's
  // (topology.ts's own rule: a producer only ever needs an exchange name
  // and a routing key). This is this demo's own bootstrap step; a real
  // long-running consumer would do the same thing on startup.
  const consumeChannel = await connection.createChannel();
  await assertTopology(consumeChannel);
  // Clean queues before measuring — leftovers from a crashed previous
  // run must not count toward THIS run's numbers (requirement #7).
  await consumeChannel.purgeQueue(QUEUE);
  await consumeChannel.purgeQueue(DLQ);

  const publishChannel = await connection.createConfirmChannel();
  const consumerDone = runConsumer(consumeChannel, pool, { prefetch: PREFETCH, stopAfter: COUNT });

  let published = 0;
  const batchId = Date.now();
  for (let i = 1; i <= COUNT; i += 1) {
    await publishOrderPlaced(publishChannel, {
      orderId: `${PREFIX}${batchId}-${i}`,
      userId: 'demo-publish-user',
      totalCents: 1000 * i,
    });
    published += 1;
  }

  const summary = await Promise.race([
    consumerDone,
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error('timeout waiting for delivery')), 15000)),
  ]);

  const delivered = await countDeliveries(pool, PREFIX);
  const effect = await countEffect(pool, PREFIX);
  const dlqInfo = await consumeChannel.checkQueue(DLQ);

  console.log(`published=${published}`);
  console.log(`delivered=${delivered}`);
  console.log(`effect=${effect}`);
  console.log(`acked=${summary.acked}`);
  console.log(`dlq=${dlqInfo.messageCount}`);
  console.log(`prefetch=${PREFETCH}`);

  await connection.close();
  await pool.end();

  const ok = published === COUNT && effect === COUNT && dlqInfo.messageCount === 0;
  process.exit(ok ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

// npm run demo:dlq — a poison message gets rejected (requeue=false, not a
// retry loop), lands in the DLQ via x-dead-letter-exchange, and its death
// reason is read back from x-first-death-reason — one of the four, and
// only four, legal reasons RabbitMQ ever dead-letters a message for.
import 'dotenv/config';
import { createDbPool } from './db';
import { connectBroker } from './connection';
import { assertTopology, QUEUE, DLQ } from './topology';
import { publishOrderPlaced } from './publisher';
import { ensureSchema, resetDemoState, countEffect } from './effect';
import { runConsumer } from './consumer';

const PREFIX = 'demo-dlq:';
const PREFETCH = Number(process.env.PREFETCH ?? 10);
const VALID_REASONS = new Set(['rejected', 'expired', 'maxlen', 'delivery_limit']);

async function main(): Promise<void> {
  const pool = createDbPool();
  await ensureSchema(pool);
  await resetDemoState(pool, PREFIX);

  const connection = await connectBroker();
  connection.on('error', (err) => console.error('[broker connection]', err.message));

  // Topology declared on the consumer's channel, never the publisher's —
  // see demo-publish.ts's comment for why.
  const consumeChannel = await connection.createChannel();
  await assertTopology(consumeChannel);
  await consumeChannel.purgeQueue(QUEUE);
  await consumeChannel.purgeQueue(DLQ);

  const publishChannel = await connection.createConfirmChannel();
  const consumerDone = runConsumer(consumeChannel, pool, {
    prefetch: PREFETCH,
    stopAfter: 1,
    // The poison marker lives in the event's own data, not in some
    // out-of-band signal — this is what a REAL unprocessable message
    // (a malformed payload, a business rule the consumer can't satisfy)
    // looks like from the consumer's side.
    isPoison: (data) => data.poison === true,
  });

  await publishOrderPlaced(publishChannel, {
    orderId: `${PREFIX}${Date.now()}`,
    userId: null,
    totalCents: 0,
    poison: true,
  });

  const summary = await Promise.race([
    consumerDone,
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error('timeout waiting for rejection')), 15000)),
  ]);

  // Peek the DLQ, not consume it: get() + nack(requeue=true) reads the
  // message and its x-death headers, then puts it straight back — so
  // `dlq=1` is still true after this script exits, not `dlq=0` because
  // reading it happened to remove it.
  //
  // `channel.reject()` above only QUEUES the basic.reject frame — the
  // broker's own dead-lettering (routing the message to the DLX, then
  // into this queue) happens over the wire afterward, not before reject()
  // returns. A `get()` fired immediately can race ahead of that and find
  // nothing yet, even though the message always lands within a few
  // milliseconds — so this polls instead of trusting a single attempt.
  let reason = 'unknown';
  for (let attempt = 0; attempt < 20 && reason === 'unknown'; attempt += 1) {
    const dlqMessage = await consumeChannel.get(DLQ, { noAck: false });
    if (dlqMessage) {
      const headers = dlqMessage.properties.headers ?? {};
      reason = headers['x-first-death-reason'] ?? headers['x-death']?.[0]?.reason ?? 'unknown';
      consumeChannel.nack(dlqMessage, false, true);
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  const workInfo = await consumeChannel.checkQueue(QUEUE);
  const dlqInfo = await consumeChannel.checkQueue(DLQ);
  const effect = await countEffect(pool, PREFIX);

  console.log(`rejected=${summary.rejected}`);
  console.log(`work=${workInfo.messageCount}`);
  console.log(`dlq=${dlqInfo.messageCount}`);
  console.log(`dlq-reason=${reason}`);
  console.log(`effect=${effect}`);

  await connection.close();
  await pool.end();

  const ok = workInfo.messageCount === 0 && dlqInfo.messageCount === 1 && VALID_REASONS.has(reason);
  process.exit(ok ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

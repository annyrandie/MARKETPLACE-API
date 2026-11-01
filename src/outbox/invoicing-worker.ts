// npm run outbox:consumer — the invoicing consumer as a long-running
// process (the demos run the same runInvoicingConsumer() in-process).
import 'dotenv/config';
import { createDbPool } from '../events/db';
import { connectBroker } from '../events/connection';
import { assertTopology } from '../events/topology';
import { runInvoicingConsumer } from './invoicing.consumer';

// Same arithmetic as HW #19's consumer: one short transaction per message
// (two INSERTs, single-digit ms) × 10 ≪ the 30-minute consumer_timeout.
const PREFETCH = Number(process.env.PREFETCH ?? 10);

async function main(): Promise<void> {
  const pool = createDbPool();
  const connection = await connectBroker();
  connection.on('error', (err) => console.error('[broker connection]', err.message));
  const channel = await connection.createChannel();
  await assertTopology(channel);

  await runInvoicingConsumer(channel, pool, {
    prefetch: PREFETCH,
    onDelivery: (event, outcome) => console.error(`${outcome.toUpperCase()} ${event.eventId}`),
  });
  console.error(`invoicing consumer up (prefetch=${PREFETCH})`);
}

main().catch((err) => {
  console.error('invoicing-worker failed:', err);
  process.exit(1);
});

// The outbox relay as its own OS process.
//
//   npm run outbox:relay                       — long-running, polls every RELAY_POLL_MS
//   node dist/outbox/relay-worker.js --once    — one drain, then exit
//   node dist/outbox/relay-worker.js --once --crash-after-publish
//       — demo:crash-relay's victim: publishes, gets the broker's confirm,
//         then SIGKILLs itself before `UPDATE published_at`. A real kill -9
//         of a real process: its Postgres session dies with the transaction
//         still open, so the row lock is released and published_at stays NULL.
//
// Declares no topology — a producer only needs the exchange name; the
// consumer side (invoicing-worker / the demos) owns the queues.
import 'dotenv/config';
import { createDbPool } from '../events/db';
import { connectBroker } from '../events/connection';
import { relayOnce, drainOutbox } from './relay';

const BATCH_SIZE = Number(process.env.RELAY_BATCH_SIZE ?? 50);
const POLL_MS = Number(process.env.RELAY_POLL_MS ?? 500);

async function main(): Promise<void> {
  const once = process.argv.includes('--once');
  const crashAfterPublish = process.argv.includes('--crash-after-publish');

  const pool = createDbPool();
  const connection = await connectBroker();
  connection.on('error', (err) => console.error('[broker connection]', err.message));
  const channel = await connection.createConfirmChannel();

  if (crashAfterPublish) {
    await relayOnce(pool, channel, {
      batchSize: BATCH_SIZE,
      afterPublish: (ids) => {
        console.error(`RELAY published outbox ids=${ids.join(',')} — crashing before UPDATE published_at`);
        process.kill(process.pid, 'SIGKILL'); // never returns
      },
    });
    throw new Error('--crash-after-publish found nothing to publish');
  }

  if (once) {
    const n = await drainOutbox(pool, channel, BATCH_SIZE);
    console.error(`RELAY published ${n}`);
  } else {
    let stopping = false;
    process.on('SIGTERM', () => (stopping = true));
    process.on('SIGINT', () => (stopping = true));
    console.error(`relay polling every ${POLL_MS}ms (batch ${BATCH_SIZE})`);
    while (!stopping) {
      try {
        const n = await relayOnce(pool, channel, { batchSize: BATCH_SIZE });
        if (n > 0) console.error(`RELAY published ${n}`);
        if (n === BATCH_SIZE) continue; // backlog — don't sleep between full batches
      } catch (err) {
        console.error('[relay] pass failed, retrying next tick:', err instanceof Error ? err.message : err);
      }
      await new Promise((r) => setTimeout(r, POLL_MS));
    }
  }

  await channel.close();
  await connection.close();
  await pool.end();
}

main().catch((err) => {
  console.error('relay-worker failed:', err);
  process.exit(1);
});

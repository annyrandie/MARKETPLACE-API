// Standalone CLI entry, spawned as a SEPARATE OS process by
// demo-duplicate.ts — specifically so a simulated crash (`--crash-after-
// effect`) can be a REAL `SIGKILL` on a REAL process, dropping a REAL TCP
// connection to the broker, rather than a same-process shortcut that
// never actually proves RabbitMQ's redelivery behavior.
//
// Usage: node dist/events/consumer-worker.js --stop-after 1 [--crash-after-effect]
import 'dotenv/config';
import { createDbPool } from './db';
import { connectBroker } from './connection';
import { assertTopology } from './topology';
import { ensureSchema } from './effect';
import { runConsumer } from './consumer';

function flagValue(name: string, fallback: string): string {
  const i = process.argv.indexOf(name);
  return i === -1 ? fallback : process.argv[i + 1];
}

async function main(): Promise<void> {
  const stopAfter = Number(flagValue('--stop-after', '1'));
  const crashAfterEffect = process.argv.includes('--crash-after-effect');
  const prefetch = Number(process.env.PREFETCH ?? 10);

  const pool = createDbPool();
  await ensureSchema(pool);

  const connection = await connectBroker();
  connection.on('error', (err) => console.error('[broker connection]', err.message));
  const channel = await connection.createChannel();
  await assertTopology(channel);

  await runConsumer(channel, pool, { prefetch, stopAfter, crashAfterEffect });

  // Only reached on the non-crashing path — `process.kill(pid, 'SIGKILL')`
  // inside runConsumer() never returns control here.
  await connection.close();
  await pool.end();
  process.exit(0);
}

main().catch((err) => {
  console.error('consumer-worker failed:', err);
  process.exit(1);
});

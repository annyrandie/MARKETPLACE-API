// npm run demo:duplicate — the whole point of the HW in one script: the
// SAME event gets delivered twice (a real crash, not a clean shutdown —
// see below), and the idempotent effect still only applies once.
//
// The "crash" is a literal `kill -9` on a CHILD PROCESS, after it has
// already applied the effect but before it acks — not `channel.close()`.
// A clean close also requeues the unacked message, but it's a graceful
// shutdown; what a crash at 3am actually looks like is the process
// disappearing out from under an open TCP connection, which only a real
// process death demonstrates.
import 'dotenv/config';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createDbPool } from './db';
import { connectBroker } from './connection';
import { assertTopology, QUEUE, DLQ } from './topology';
import { publishOrderPlaced } from './publisher';
import { ensureSchema, resetDemoState, countEffect, countDeliveries } from './effect';

const PREFIX = 'demo-duplicate:';
const WORKER = path.resolve(__dirname, 'consumer-worker.js');
// If RabbitMQ were somehow slow to notice the first worker's dropped TCP
// connection, the second worker would otherwise wait forever for a
// redelivery that hasn't happened yet — this is this script's version of
// demo-publish.ts/demo-dlq.ts's own 15s ceiling, so a stalled run fails
// loudly instead of hanging with no output.
const WORKER_TIMEOUT_MS = 15000;

function runWorker(extraArgs: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [WORKER, '--stop-after', '1', ...extraArgs], {
      env: process.env,
      stdio: 'inherit',
    });
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`worker (${extraArgs.join(' ') || 'plain'}) did not exit within ${WORKER_TIMEOUT_MS}ms`));
    }, WORKER_TIMEOUT_MS);
    // Resolve on ANY exit — a SIGKILL'd child has no exit code (it's
    // `null`, with `signal` set instead), which is expected and fine:
    // this promise only needs to know the child is no longer running
    // before the next step reconnects and claims the redelivered message.
    child.on('exit', () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

async function main(): Promise<void> {
  const pool = createDbPool();
  await ensureSchema(pool);
  await resetDemoState(pool, PREFIX);

  const connection = await connectBroker();
  connection.on('error', (err) => console.error('[broker connection]', err.message));

  // A dedicated bootstrap step (requirement #1 explicitly allows either
  // the consumer or "a separate bootstrap step" to declare topology) —
  // not the publish channel, which only ever needs the exchange name and
  // routing key, same as every other demo here.
  const setupChannel = await connection.createChannel();
  await assertTopology(setupChannel);
  await setupChannel.purgeQueue(QUEUE);
  await setupChannel.purgeQueue(DLQ);

  const publishChannel = await connection.createConfirmChannel();
  const orderId = `${PREFIX}${Date.now()}`;
  await publishOrderPlaced(publishChannel, { orderId, userId: 'demo-duplicate-user', totalCents: 2500 });
  await connection.close(); // this script's own connection — the workers open their own

  // First delivery: applies the effect, then SIGKILLs itself before ack.
  await runWorker(['--crash-after-effect']);

  // RabbitMQ sees that connection drop and redelivers the still-unacked
  // message. Second delivery: a fresh process, same event, acks normally.
  await runWorker([]);

  const deliveries = await countDeliveries(pool, PREFIX);
  const effect = await countEffect(pool, PREFIX);

  console.log(`deliveries=${deliveries}`);
  console.log(`effect=${effect}`);

  await pool.end();

  const ok = deliveries >= 2 && effect === 1;
  process.exit(ok ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
